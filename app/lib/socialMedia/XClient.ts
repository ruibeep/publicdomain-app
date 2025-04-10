import { VercelPoolClient } from "@vercel/postgres";
import { BaseSocialMediaClient, SocialMediaClient } from "./SocialMediaClient";
import { TwitterApi, TweetV2 } from 'twitter-api-v2';

// Book rows from the DB
type BookRow = {
  title: string;
  link: string;
  author: string;
};

// Extended tweet type with custom fields
type EnrichedTweet = TweetV2 & {
  author_id: string;  // guaranteed by expansions
  username?: string;
  name?: string;
  followers: number;
  book_title?: string;
  book_author?: string;
  book_link?: string;
};

// Summary returned by quarterHourly
export interface QuarterHourlySummary {
  repliesInThisRun: number;
  repliesInLast24: number;
  booksProcessed: number;
  totalBooks: number;
  errors: string[];
}

export class XClient extends BaseSocialMediaClient implements SocialMediaClient {
  protected platform = 'X';
  private XApi: TwitterApi;

  constructor(apiConfig: { appKey: string; appSecret: string; accessToken: string; accessSecret: string }) {
    super();
    this.XApi = new TwitterApi({
      appKey: apiConfig.appKey,
      appSecret: apiConfig.appSecret,
      accessToken: apiConfig.accessToken,
      accessSecret: apiConfig.accessSecret,
    });
  }

  /* ------------------------------------------------------------------
   * A) QUARTER-HOURLY: Return a summary with replies, errors, etc.
   * ------------------------------------------------------------------ */
  public async quarterHourly(client: VercelPoolClient): Promise<QuarterHourlySummary> {
    // Build an initial summary
    const summary: QuarterHourlySummary = {
      repliesInThisRun: 0,
      repliesInLast24: 0,
      booksProcessed: 0,
      totalBooks: 0,
      errors: [],
    };

    // 0. Check how many replies in last 24 hours
    const countResult = await client.sql`
      SELECT COUNT(*) AS last24
      FROM replies
      WHERE replied_at >= NOW() - INTERVAL '24 hours'
    `;
    summary.repliesInLast24 = parseInt(countResult.rows[0].last24, 10);

    if (summary.repliesInLast24 >= 90) {
      // We skip if we already have 90+ replies
      summary.errors.push(`Already made ${summary.repliesInLast24} replies in last 24 hours; skipping new replies.`);
      return summary;
    }

    // 1. Check total books
    const totalRes = await client.sql`SELECT COUNT(*) AS total FROM books;`;
    const totalBooks = parseInt(totalRes.rows[0].total, 10);
    summary.totalBooks = totalBooks;

    if (totalBooks === 0) {
      summary.errors.push("No books found. Aborting quarterHourly.");
      return summary;
    }

    // 2. Check if hour changed
    const now = new Date();
    const currentHour = now.getHours();
    const lastHour = await this.getCurrentBookSearchHour(client);

    if (currentHour !== lastHour) {
      await this.setCurrentBookOffset(client, 0);
      await this.setCurrentBookSearchHour(client, currentHour);
      // Not necessarily an error — just log it
      summary.errors.push(`Hour changed from ${lastHour} to ${currentHour}. Reset offset to 0.`);
    }

    // 3. Determine how many books per run
    const chunk = Math.min(50, Math.ceil(totalBooks / 4));

    // 4. Get current offset
    const offset = await this.getCurrentBookOffset(client);

    // 5. Fetch next chunk of books
    const booksResult = await client.sql`
      SELECT b.title, b.link, a.name AS author
      FROM books b
      JOIN authors a ON b.author_id = a.id
      ORDER BY b.id
      LIMIT ${chunk}
      OFFSET ${offset}
    `;
    const books = booksResult.rows as BookRow[];

    if (!books.length) {
      // near end, reset offset
      await this.setCurrentBookOffset(client, 0);
      summary.errors.push("No books returned. Possibly end of DB; reset offset to 0.");
      return summary;
    }

    // 6. Use the pipeline to search & reply. We'll get partial info from it.
    try {
      const runResult = await this.replyToAllBookMentions(client, books);
      summary.booksProcessed = runResult.booksProcessed;
      summary.repliesInThisRun = runResult.repliesMade;
      // Merge any errors from runResult
      summary.errors.push(...runResult.errors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`Error in replyToAllBookMentions: ${message}`);
    }

    // 7. Advance offset
    let newOffset = offset + chunk;
    if (newOffset >= totalBooks) {
      newOffset = 0;
    }
    await this.setCurrentBookOffset(client, newOffset);

    return summary;
  }

  /* ------------------------------------------------------------------
   * B) REPLY TO ALL BOOK MENTIONS: returns partial summary
   * ------------------------------------------------------------------ */
  private async replyToAllBookMentions(
    client: VercelPoolClient,
    books: BookRow[]
  ): Promise<{
    repliesMade: number;
    booksProcessed: number;
    errors: string[];
  }> {
    let repliesMade = 0;
    const errors: string[] = [];

    // total books processed is just the length of 'books'
    const booksProcessed = books.length;

    // 1. Gather all matching tweets for these books
    const allPosts: EnrichedTweet[] = [];

    for (const { title, author, link } of books) {
      try {
        const posts = await this.searchPosts(title, author);
        const filteredPosts = this.filterSuspiciousUsernames(posts);

        // Attach book metadata
        const enriched = filteredPosts.map(tweet => ({
          ...tweet,
          book_title: title,
          book_author: author,
          book_link: link,
        }));

        allPosts.push(...enriched);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`Error searching "${title}" by "${author}": ${msg}`);
      }
    }

    if (!allPosts.length) {
      // No posts to process
      return { repliesMade, booksProcessed, errors };
    }

    // 2. Remove users already replied to in last 30 days
    let postsFromNewUsers: EnrichedTweet[] = [];
    try {
      postsFromNewUsers = await this.removePostsWithKnownUsers(allPosts, client);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Error removing known users: ${msg}`);
      // fallback: if error, just keep all
      postsFromNewUsers = allPosts;
    }

    // 3. Select top 10
    const topPosts = this.selectTopPosts(postsFromNewUsers);

    // 4. Actually reply
    for (const top of topPosts) {
      const postData = postsFromNewUsers.find(p => p.id === top.id);
      if (!postData) continue;

      try {
        // replyToPosts can return how many we replied to
        const count = await this.replyToPosts(
          [{ id: postData.id, author_id: postData.author_id }],
          postData.book_link ?? '',
          postData.book_title ?? '',
          postData.book_author ?? '',
          client
        );
        repliesMade += count;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Error replying to tweet: ${msg}`);
      }
    }

    return { repliesMade, booksProcessed, errors };
  }

  /* ------------------------------------------------------------------
   * C) REPLYTOPOSTS: Return how many replies were successful
   * ------------------------------------------------------------------ */
  private async replyToPosts(
    posts: { id: string; author_id: string }[],
    link: string,
    title: string,
    author: string,
    client: VercelPoolClient
  ): Promise<number> {
    let successCount = 0;
    const utmLink = `${link}?utm_source=t.co&utm_medium=referral&utm_campaign=x-replies`;
    const message = `Download for free the ebook "${title}" by ${author}\n${utmLink}`;

    for (const post of posts) {
      try {
        // Attempt to reply
        await this.XApi.v2.reply(message, post.id);
        successCount++;

        // Build post URL
        const username = "UnknownUser"; // or fetch from your local data
        const postUrl = `https://twitter.com/${username}/status/${post.id}`;

        // Insert or update the replies table
        await client.sql`
          INSERT INTO replies (user_id, username, post_id, post_url, book_title)
          VALUES (
            ${post.author_id},
            ${username},
            ${post.id},
            ${postUrl},
            ${title}
          )
          ON CONFLICT (user_id)
          DO UPDATE
            SET
              replied_at = now(),
              username = EXCLUDED.username,
              post_id = EXCLUDED.post_id,
              post_url = EXCLUDED.post_url,
              book_title = EXCLUDED.book_title
        `;
      } catch (error) {
        // Throw to log the error in replyToAllBookMentions
        throw error;
      }
    }
    return successCount;
  }

  /* ------------------------------------------------------------------
   * D) HELPER METHODS: Remove known users, search, filter, etc.
   * ------------------------------------------------------------------ */
  private async removePostsWithKnownUsers(
    allPosts: EnrichedTweet[],
    client: VercelPoolClient
  ): Promise<EnrichedTweet[]> {
    if (!allPosts.length) return [];

    const uniqueUserIds = [...new Set(allPosts.map(post => post.author_id))];
    if (!uniqueUserIds.length) return allPosts;

    const placeholders = uniqueUserIds.map((_, i) => `$${i + 1}`).join(", ");
    const query = `
      SELECT user_id
      FROM replies
      WHERE user_id IN (${placeholders})
        AND replied_at >= NOW() - INTERVAL '30 days'
    `;
    const result = await client.query(query, uniqueUserIds);
    const knownUserIds = new Set(result.rows.map(row => row.user_id));

    // Filter out posts from known users
    return allPosts.filter(post => !knownUserIds.has(post.author_id));
  }

  // Searching posts, filtering suspicious usernames
  async searchPosts(title: string, author: string): Promise<EnrichedTweet[]> {
    const authorParts = author.trim().split(/\s+/);
    const authorNameToSearch = authorParts.length > 1 ? authorParts.at(-1) : author;

    const query = `"${title}" "${authorNameToSearch}" lang:en -is:retweet -is:reply -has:links`;

    const now = new Date();
    const end = new Date(now);
    end.setUTCMinutes(0, 0, 0);
    const start = new Date(end);
    start.setUTCHours(end.getUTCHours() - 1);
    const startTime = start.toISOString();
    const endTime = end.toISOString();

    const results = await this.XApi.v2.search(query, {
      start_time: startTime,
      end_time: endTime,
      max_results: 50,
      'tweet.fields': ['created_at', 'author_id', 'text', 'public_metrics'],
      expansions: ['author_id'],
      'user.fields': ['username', 'name', 'public_metrics'],
    });

    const tweets = results.tweets ?? [];
    const users = results.includes?.users ?? [];

    const enrichedTweets: EnrichedTweet[] = tweets.map((tweet) => {
      const user = users.find(u => u.id === tweet.author_id);
      return {
        ...tweet,
        author_id: tweet.author_id ?? '',
        username: user?.username,
        name: user?.name,
        followers: user?.public_metrics?.followers_count ?? 0,
      };
    });

    return enrichedTweets;
  }

  private filterSuspiciousUsernames(tweets: EnrichedTweet[]): EnrichedTweet[] {
    const isSuspiciousUsername = (username?: string) =>
      username ? /\d{4,}/.test(username) : true;

    return tweets.filter(tweet => {
      if (isSuspiciousUsername(tweet.username)) {
        return false;
      }
      return true;
    });
  }

  private selectTopPosts(tweets: EnrichedTweet[]): { id: string; author_id: string }[] {
    return tweets
      .map(tweet => ({
        id: tweet.id,
        author_id: tweet.author_id,
        score: (tweet.public_metrics?.like_count ?? 0) + tweet.followers,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ id, author_id }) => ({ id, author_id }));
  }

  /* ------------------------------------------------------------------
   * E) SYSTEM SETTINGS: hour + offset
   * ------------------------------------------------------------------ */
  private async getCurrentBookSearchHour(client: VercelPoolClient): Promise<number> {
    const hourRes = await client.sql`
      SELECT value FROM system_settings
      WHERE key = 'book_search_hour'
    `;
    if (!hourRes.rows.length) {
      await client.sql`
        INSERT INTO system_settings(key, value)
        VALUES ('book_search_hour', '-1')
        ON CONFLICT(key) DO NOTHING
      `;
      return -1;
    }
    return parseInt(hourRes.rows[0].value, 10);
  }

  private async setCurrentBookSearchHour(client: VercelPoolClient, hour: number) {
    await client.sql`
      INSERT INTO system_settings(key, value)
      VALUES ('book_search_hour', ${hour.toString()})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  private async getCurrentBookOffset(client: VercelPoolClient): Promise<number> {
    const offsetRes = await client.sql`
      SELECT value FROM system_settings
      WHERE key = 'book_search_offset'
    `;
    if (!offsetRes.rows.length) {
      await client.sql`
        INSERT INTO system_settings(key, value)
        VALUES ('book_search_offset', '0')
        ON CONFLICT(key) DO NOTHING
      `;
      return 0;
    }
    return parseInt(offsetRes.rows[0].value, 10);
  }

  private async setCurrentBookOffset(client: VercelPoolClient, offset: number) {
    await client.sql`
      INSERT INTO system_settings(key, value)
      VALUES ('book_search_offset', ${offset.toString()})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  /* ------------------------------------------------------------------
   * F) SCHEDULING LOGIC FOR DAILY POSTS (Optional)
   * ------------------------------------------------------------------ */

  // Example: schedule 1 post for tomorrow
  public async schedulePost(client: VercelPoolClient): Promise<any[]> {
    console.log('Step 1: Check if there are already posts for tomorrow...');
    const existingPosts = await client.sql`
      SELECT 1
      FROM posts
      WHERE status = 'scheduled'
        AND platform LIKE '%X%'
        AND DATE(published_date) = CURRENT_DATE + INTERVAL '1 day';
    `;

    if (existingPosts.rows.length > 0) {
      console.log('   A post for tomorrow already exists. Aborting...');
      return [];
    } else {
      console.log('   No scheduled posts found for tomorrow. Proceeding...');
    }

    console.log('Step 2: Fetch the next quote to publish...');
    const quoteToPostResult = await client.sql`
      WITH book_quote_counts AS (
        SELECT
          b.id AS book_id,
          b.title AS book_title,
          b.cover AS book_cover,
          a.name AS author_name,
          COUNT(p.id) AS book_post_count
        FROM books b
        JOIN authors a ON b.author_id = a.id
        LEFT JOIN quotes q ON b.id = q.book_id
        LEFT JOIN posts p ON q.id = p.quote_id
        GROUP BY
          b.id, b.title, b.cover, a.name
      ),
      quote_post_counts AS (
        SELECT
          q.id AS quote_id,
          q.quote,
          q.popularity,
          q.book_id,
          COUNT(p.id) AS quote_post_count
        FROM quotes q
        LEFT JOIN posts p ON q.id = p.quote_id
        GROUP BY
          q.id, q.quote, q.popularity, q.book_id
      ),
      filtered_books AS (
        SELECT
          bq.book_id,
          bq.book_title,
          bq.book_cover,
          bq.author_name,
          MIN(qpc.quote_post_count) AS min_quote_post_count,
          bq.book_post_count
        FROM book_quote_counts bq
        JOIN quote_post_counts qpc ON bq.book_id = qpc.book_id
        GROUP BY
          bq.book_id, bq.book_title, bq.book_cover, bq.author_name, bq.book_post_count
        ORDER BY
          bq.book_post_count ASC
      ),
      final_quotes AS (
        SELECT
          qpc.quote_id,
          qpc.quote,
          qpc.book_id,
          fb.book_title,
          fb.book_cover,
          fb.author_name,
          qpc.popularity
        FROM filtered_books fb
        JOIN quote_post_counts qpc ON fb.book_id = qpc.book_id
        WHERE qpc.quote_post_count = fb.min_quote_post_count
        ORDER BY
          fb.book_post_count ASC,
          qpc.quote_post_count ASC,
          qpc.popularity DESC
      )
      SELECT
        quote_id,
        quote,
        book_id,
        book_title,
        book_cover,
        author_name,
        popularity
      FROM final_quotes
      LIMIT 1;
    `;

    const quoteToPost = quoteToPostResult.rows;
    if (!quoteToPost.length) {
      console.log('   No quotes available to schedule. Aborting...');
      return [];
    } else {
      console.log('   Next Quote to post:', quoteToPost[0].quote);
    }

    console.log('Step 3: Build the post text dynamically ...');
    const item = quoteToPost[0];
    const postText = `"${item.quote}" - ${item.book_title} by ${item.author_name} #ebooks #mustread #booklovers #book #ReadersCommunity #bookrecommendations #kindlebooks #ClassicLitMonday #BookologyThursday`;
    console.log('  Post text:', postText);

    console.log('Step 4: Insert the new post for tomorrow ...');
    const data = await client.sql`
      INSERT INTO posts (quote_id, text, image_link, platform, status, published_date)
      VALUES (
        ${item.quote_id},
        ${postText},
        ${item.book_cover},
        'X',
        'scheduled',
        (CURRENT_DATE + INTERVAL '1 day')
      )
      RETURNING id;
    `;

    console.log(`   Scheduled 1 post for tomorrow: Quote ID ${item.quote_id}, Text: "${postText}".`);
    return data.rows;
  }

  public async publishScheduledPosts(client: VercelPoolClient): Promise<void> {
    try {
      console.log('Fetching scheduled posts...');
      const scheduledPosts = await this.fetchScheduledPosts(client);
      console.log('Fetch scheduled posts done.');

      if (!scheduledPosts.length) {
        console.error('No posts scheduled for today.');
      }

      console.log(`Found ${scheduledPosts.length} posts for today. Posting...`);

      for (const post of scheduledPosts) {
        try {
          await this.postToTwitter(post.text, post.image_link);
          await this.updatePostStatus(client, post.id);
          console.log(`Post ID ${post.id} published successfully.`);
        } catch (error) {
          if (error instanceof Error) {
            console.error(`Failed to publish post ID ${post.id}:`, error.message);
          } else {
            console.error(`Unexpected error while publishing post ID ${post.id}:`, error);
          }
          throw error; // Re-throw after logging
        }
      }

      console.log('All posts scheduled for today have been processed.');
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error processing scheduled posts:', error.message);
      } else {
        console.error('An unexpected error processing scheduled posts:', error);
      }
      throw error;
    }
  }

  public async fetchScheduledPosts(client: VercelPoolClient): Promise<any[]> {
    const postsForToday = await client.sql`
      SELECT id, quote_id, text, image_link
      FROM posts
      WHERE status = 'scheduled'
        AND platform LIKE '%X%'
        AND DATE(published_date) = CURRENT_DATE;
    `;
    return postsForToday.rows;
  }

  public async updatePostStatus(client: VercelPoolClient, postId: number) {
    await client.sql`
      UPDATE posts
      SET status = 'published'
      WHERE id = ${postId};
    `;
  }

  /* ------------------------------------------------------------------
   * G) POST DIRECTLY TO TWITTER
   * ------------------------------------------------------------------ */
  public async postToTwitter(text: string, imageLink?: string | null) {
    try {
      if (imageLink) {
        console.log('Downloading image...');
        const imageBuffer = await this.downloadImage(imageLink);

        console.log('Uploading image to Twitter...');
        const mediaId = await this.XApi.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });

        // Post with media
        console.log('Making the post...');
        const response = await this.XApi.v2.tweet({ text, media: { media_ids: [mediaId] } });

        console.log('Successfully posted with image:', response);
        return response;
      } else {
        // Text-only
        const response = await this.XApi.v2.tweet(text);
        console.log('Successfully posted:', response);
        return response;
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error posting tweet:', error.message);
      } else {
        console.error('An unexpected error occurred:', error);
      }
      throw error;
    }
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}