import { VercelPoolClient } from "@vercel/postgres";
import { BaseSocialMediaClient, SocialMediaClient } from "./SocialMediaClient";
import { TwitterApi, TweetV2 } from 'twitter-api-v2';

// Extend TweetV2 to include your custom fields
type EnrichedTweet = TweetV2 & {
  // from Twitter
  author_id: string;     // guaranteed by expansions
  username?: string;     // assigned in search
  name?: string;         // assigned in search
  followers: number;     // assigned in search

  // custom book fields
  book_title?: string;
  book_author?: string;
  book_link?: string;
};

// Shape of rows returned by the SELECT query in quarterHourly
type BookRow = {
  title: string;
  link: string;
  author: string;
};

export class XClient extends BaseSocialMediaClient implements SocialMediaClient {
  protected platform = 'X';
  private XApi: TwitterApi;

  constructor(apiConfig: { appKey: string; appSecret: string; accessToken: string; accessSecret: string }) {
    super();
    // Initialize Twitter client with OAuth 1.0a credentials
    this.XApi = new TwitterApi({
      appKey: apiConfig.appKey,
      appSecret: apiConfig.appSecret,
      accessToken: apiConfig.accessToken,
      accessSecret: apiConfig.accessSecret,
    });
  }

  /**
   * ---------------------------------------------------------
   *  A) HELPER FUNCTIONS (System Settings)
   * ---------------------------------------------------------
   */
  private async getSystemSetting(client: VercelPoolClient, key: string): Promise<string | null> {
    const result = await client.sql`
      SELECT value 
      FROM system_settings
      WHERE key = ${key};
    `;
    if (!result.rows.length) return null;
    return result.rows[0].value;
  }

  private async setSystemSetting(client: VercelPoolClient, key: string, value: string): Promise<void> {
    // Insert or update
    await client.sql`
      INSERT INTO system_settings (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value;
    `;
  }

  // Manages the "hour" setting
  private async getCurrentBookSearchHour(client: VercelPoolClient): Promise<number> {
    const hourStr = await this.getSystemSetting(client, 'book_search_hour');
    if (hourStr === null) {
      // If missing, initialize to -1
      await this.setSystemSetting(client, 'book_search_hour', '-1');
      return -1;
    }
    return parseInt(hourStr, 10);
  }

  private async setCurrentBookSearchHour(client: VercelPoolClient, hour: number): Promise<void> {
    await this.setSystemSetting(client, 'book_search_hour', hour.toString());
  }

  // Manages the "offset" setting
  private async getCurrentBookOffset(client: VercelPoolClient): Promise<number> {
    const offsetStr = await this.getSystemSetting(client, 'book_search_offset');
    if (offsetStr === null) {
      // If missing, initialize to 0
      await this.setSystemSetting(client, 'book_search_offset', '0');
      return 0;
    }
    return parseInt(offsetStr, 10);
  }

  private async setCurrentBookOffset(client: VercelPoolClient, newOffset: number): Promise<void> {
    await this.setSystemSetting(client, 'book_search_offset', newOffset.toString());
  }

  /**
   * ---------------------------------------------------------
   *  B) QUARTER-HOURLY (Runs Every 15 Min)
   * ---------------------------------------------------------
   *  - Resets offset to 0 if hour changed
   *  - Dynamically fetches chunk of books (up to 50)
   *  - Calls replyToAllBookMentions(books) to search & reply
   *  - Moves offset for next run
   */
  public async quarterHourly(client: VercelPoolClient): Promise<{
    repliesInThisRun: number;
    repliesInLast24: number;
    booksProcessed: number;
    totalBooks: number;
    errorsCount: number;
    errors: string[];
    message: string;
  }> {
    const summary = {
      repliesInThisRun: 0,
      repliesInLast24: 0,
      booksProcessed: 0,
      totalBooks: 0,
      errorsCount: 0,
      errors: [] as string[],
      message: '',
    };

    const countResult = await client.sql`
      SELECT COUNT(*) AS last24
      FROM replies
      WHERE replied_at >= NOW() - INTERVAL '24 hours'
    `;
    summary.repliesInLast24 = parseInt(countResult.rows[0].last24, 10);

    if (summary.repliesInLast24 >= 100) {
      summary.message = `Already made ${summary.repliesInLast24} replies in last 24 hours, skipping...`;
      return summary;
    }

    const totalRes = await client.sql`SELECT COUNT(*) AS total FROM books;`;
    summary.totalBooks = parseInt(totalRes.rows[0].total, 10);

    if (summary.totalBooks === 0) {
      summary.message = 'No books in DB. Aborting quarterHourly...';
      return summary;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const lastHour = await this.getCurrentBookSearchHour(client);

    if (currentHour !== lastHour) {
      await this.setCurrentBookOffset(client, 0);
      await this.setCurrentBookSearchHour(client, currentHour);
      summary.message = `Hour changed from ${lastHour} to ${currentHour}. Reset offset to 0. `;
    }

    const chunk = Math.min(50, Math.ceil(summary.totalBooks / 4));
    summary.booksProcessed = chunk;

    const offsetStart = await this.getCurrentBookOffset(client);

    const booksResult = await client.sql`
      SELECT b.title, b.link, a.name AS author
      FROM books b
      JOIN authors a ON b.author_id = a.id
      ORDER BY b.id
      LIMIT ${chunk}
      OFFSET ${offsetStart}
    `;
    const books = booksResult.rows as BookRow[];

    if (!books.length) {
      await this.setCurrentBookOffset(client, 0);
      summary.message += `No books returned. Reset offset to 0.`;
      return summary;
    }

    try {
      const allPosts: EnrichedTweet[] = [];

      for (const { title, author, link } of books) {
        try {
          console.log(`🔍 Searching posts for "${title}" by "${author}"...`);
          const posts = await this.searchPosts(title, author);
          const filteredPosts = this.filterSuspiciousUsernames(posts);
          const enriched = filteredPosts.map(tweet => ({
            ...tweet,
            book_title: title,
            book_author: author,
            book_link: link,
          }));
          allPosts.push(...enriched);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          summary.errors.push(`❌ Error searching "${title}" by "${author}": ${msg}`);
        }
      }

      const postsFromNewUsers = await this.removePostsWithKnownUsers(allPosts, client);
      const topPosts = this.selectTopPosts(postsFromNewUsers);

      for (const top of topPosts) {
        const postData = postsFromNewUsers.find(p => p.id === top.id);
        if (!postData) continue;

        try {
          await this.replyToPosts(
            [{ id: postData.id, author_id: postData.author_id, username: postData.username }],
            postData.book_link ?? '',
            postData.book_title ?? '',
            postData.book_author ?? '',
            client
          );
          summary.repliesInThisRun++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          summary.errors.push(`❌ Error replying to post ID ${top.id}: ${msg}`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Unexpected error during reply process: ${msg}`);
    }

    let newOffset = offsetStart + chunk;
    if (newOffset >= summary.totalBooks) {
      newOffset = 0;
    }
    await this.setCurrentBookOffset(client, newOffset);

    summary.errorsCount = summary.errors.length;
    summary.message += `Processed ${books.length} book(s), made ${summary.repliesInThisRun} replies. Offset is now ${newOffset}. Done!`;

    return summary;
  }

  /**
   * ---------------------------------------------------------
   *  C) Scheduling Daily Posts Logic (Existing)
   * ---------------------------------------------------------
   */
  // Example: schedules 1 post for tomorrow
  async schedulePost(client: VercelPoolClient): Promise<any[]> {
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

  // Publish any posts scheduled for today
  async publishScheduledPosts(client: VercelPoolClient): Promise<void> {
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
          throw error; // Re-throw the error after logging
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

  async fetchScheduledPosts(client: VercelPoolClient): Promise<any[]> {
    const postsForToday = await client.sql`
      SELECT id, quote_id, text, image_link
      FROM posts
      WHERE status = 'scheduled'
        AND platform LIKE '%X%'
        AND DATE(published_date) = CURRENT_DATE;
    `;
    return postsForToday.rows;
  }

  async updatePostStatus(client: VercelPoolClient, postId: number) {
    await client.sql`
      UPDATE posts
      SET status = 'published'
      WHERE id = ${postId};
    `;
  }

  /**
   * ---------------------------------------------------------
   *  D) Twitter Post Logic
   * ---------------------------------------------------------
   */
  async postToTwitter(text: string, imageLink?: string | null) {
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
        // Post text-only tweet
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

  async downloadImage(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * ---------------------------------------------------------
   *  E) Searching tweets + filtering
   * ---------------------------------------------------------
   */
  async searchPosts(title: string, author: string): Promise<EnrichedTweet[]> {
    // If author has multiple words, search only the last word
    const authorParts = author.trim().split(/\s+/);
    const authorNameToSearch = authorParts.length > 1 ? authorParts.at(-1) : author;

    const query = `"${title}" "${authorNameToSearch}" lang:en -is:retweet -is:reply -has:links`;

    // 1. Get current time in UTC
    const now = new Date();
    // 2. Round down to start of the current hour
    const end = new Date(now);
    end.setUTCMinutes(0, 0, 0);
    // 3. Go back 1 hour for the start
    const start = new Date(end);
    start.setUTCHours(end.getUTCHours() - 1);
    // 4. Format times to ISO
    const startTime = start.toISOString();
    const endTime = end.toISOString();

    try {
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

      // Attach username, name, followers
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
    } catch (error) {
      if (error instanceof Error) {
        console.error('❌ Error during tweet search:', error.message);
      } else {
        console.error('❌ Unexpected error:', error);
      }
      throw error;
    }
  }

  private filterSuspiciousUsernames(tweets: EnrichedTweet[]): EnrichedTweet[] {
    const isSuspiciousUsername = (username?: string): boolean =>
      username ? /\d{4,}/.test(username) : true;

    return tweets.filter(tweet => {
      if (isSuspiciousUsername(tweet.username)) {
        console.log(`🚫 Skipping @${tweet.username} — suspicious username`);
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
        // Score = likes + followers
        score: (tweet.public_metrics?.like_count ?? 0) + tweet.followers,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ id, author_id }) => ({ id, author_id }));
  }

  /**
   * ---------------------------------------------------------
   *  F) Removing known users + replying
   * ---------------------------------------------------------
   */
  private async removePostsWithKnownUsers(
    allPosts: EnrichedTweet[],
    client: VercelPoolClient
  ): Promise<EnrichedTweet[]> {
    if (!allPosts.length) return [];

    // Collect unique user IDs
    const uniqueUserIds = [...new Set(allPosts.map(post => post.author_id))];
    if (!uniqueUserIds.length) return allPosts; // No user IDs to filter

    // We'll do placeholders approach, because ANY(${array}) triggers 'Primitive' error in @vercel/postgres
    const placeholders = uniqueUserIds.map((_, i) => `$${i + 1}`).join(", ");
    const query = `
      SELECT user_id
      FROM replies
      WHERE user_id IN (${placeholders})
        AND replied_at >= NOW() - INTERVAL '30 days'
    `;
    // Execute the query with the user IDs as parameters
    const result = await client.query(query, uniqueUserIds);

    // Convert rows into a Set of known user IDs
    const knownUserIds = new Set(result.rows.map(row => row.user_id));

    // Filter out posts from known users
    return allPosts.filter(post => {
      if (knownUserIds.has(post.author_id)) {
        console.log(`🚫 Skipping user ${post.author_id} — replied to within last 30 days`);
        return false;
      }
      return true;
    });
  }

  // Actually reply with the correct link and book info
  async replyToPosts(
    posts: { id: string; author_id: string; username?: string }[],
    link: string,
    title: string,
    author: string,
    client: VercelPoolClient // pass the DB client in
  ) {
    const utmLink = `${link}?utm_source=t.co&utm_medium=referral&utm_campaign=x-replies`;
    const message = `Download for free the ebook "${title}" by ${author}\n${utmLink}`;
  
    for (const post of posts) {
      try {
        console.log(`Replying to tweet ID ${post.id}...`);
  
        // 1. Send the reply
        await this.XApi.v2.reply(message, post.id);
        console.log(`✅ Replied to tweet ID ${post.id}`);
  
        // 2. Build the post URL using username (fallback to "UnknownUser")
        const username = post.username ?? "UnknownUser";
        const postUrl = `https://twitter.com/${username}/status/${post.id}`;
  
        // 3. Upsert into the replies table
        await this.insertReplyRecord(
          client,
          post.author_id,
          username,
          post.id,
          postUrl,
          title
        );
        console.log(`✅ Logged reply to user ${post.author_id} in 'replies' table.`);
      } catch (error) {
        if (error instanceof Error) {
          console.error(`❌ Failed to reply to tweet ID ${post.id}:`, error.message);
        } else {
          console.error(`❌ Unknown error replying to tweet ID ${post.id}:`, error);
        }
      }
    }
  }

  private async insertReplyRecord(
    client: VercelPoolClient,
    userId: string,
    username: string,
    postId: string,
    postUrl: string,
    bookTitle: string
  ): Promise<void> {
    // ON CONFLICT on user_id ensures you can't reply to the same user more than once in 30 days
    await client.sql`
      INSERT INTO replies (user_id, username, post_id, post_url, book_title)
      VALUES (${userId}, ${username}, ${postId}, ${postUrl}, ${bookTitle})
      ON CONFLICT (user_id)
      DO UPDATE
        SET
          replied_at = now(),
          username = EXCLUDED.username,
          post_id = EXCLUDED.post_id,
          post_url = EXCLUDED.post_url,
          book_title = EXCLUDED.book_title
    `;
  }

  /**
   * ---------------------------------------------------------
   *  G) Main pipeline (if needed) for existing usage
   * ---------------------------------------------------------
   *
   * This method now accepts an array of books from quarterHourly,
   * rather than fetching random 50 inside. But you can keep or remove it
   * as you like.
   */
  public async replyToAllBookMentions(
    client: VercelPoolClient,
    books: BookRow[]
  ): Promise<void> {
    console.log(`replyToAllBookMentions invoked with ${books.length} book(s)`);

    if (!books.length) {
      console.log("⚠️ No books found. Aborting...");
      return;
    }

    // 1. Gather all matching tweets from these books
    const allPosts: EnrichedTweet[] = [];

    for (const { title, author, link } of books) {
      try {
        console.log(`🔍 Searching posts for "${title}" by "${author}"...`);
        const posts = await this.searchPosts(title, author);

        // Filter out suspicious usernames
        const filteredPosts = this.filterSuspiciousUsernames(posts);
        console.log(`   Found ${posts.length} posts, kept ${filteredPosts.length} after suspicious filter.`);

        // Attach book metadata
        const enriched = filteredPosts.map(tweet => ({
          ...tweet,
          book_title: title,
          book_author: author,
          book_link: link,
        }));

        allPosts.push(...enriched);
      } catch (error) {
        console.error(`❌ Error searching "${title}":`, error);
      }
    }

    console.log(`✅ Total posts across these ${books.length} book(s): ${allPosts.length}`);

    if (!allPosts.length) {
      console.log("⚠️ No posts to process. Aborting...");
      return;
    }

    // 2. Remove users already replied to in last 30 days
    const postsFromNewUsers = await this.removePostsWithKnownUsers(allPosts, client);
    console.log(`🧹 After removing known users: ${postsFromNewUsers.length} posts remain.`);

    // 3. Select top 10
    const topPosts = this.selectTopPosts(postsFromNewUsers);
    console.log(`🏆 Chosen top ${topPosts.length} posts.`);

    // 4. Reply to each top post with the correct book info
    for (const top of topPosts) {
      // Find the full data from `postsFromNewUsers` (including book_link, etc.)
      const postData = postsFromNewUsers.find(p => p.id === top.id);
      if (!postData) continue;

      await this.replyToPosts(
        [{ id: postData.id, author_id: postData.author_id, username: postData.username}],
        postData.book_link ?? '',
        postData.book_title ?? '',
        postData.book_author ?? '',
        client
      );
    }

    console.log("🎉 Finished replying to top posts.");
  }
}