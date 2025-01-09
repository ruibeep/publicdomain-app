import { db } from '@vercel/postgres';
import snoowrap from 'snoowrap';

const client = await db.connect();

interface SocialMediaClient {
  schedulePost(): Promise<any[]>;
  publishScheduledPosts(): Promise<void>;
}

class RedditClient implements SocialMediaClient {
  private redditApi: snoowrap;

  constructor(apiConfig: { clientId: string; clientSecret: string; username: string; password: string; userAgent: string }) {
    this.redditApi = new snoowrap({
      clientId: apiConfig.clientId,
      clientSecret: apiConfig.clientSecret,
      username: apiConfig.username,
      password: apiConfig.password,
      userAgent: apiConfig.userAgent,
    });
  }
  async schedulePost(): Promise<any[]> {
    console.log('Step 1: Check if there are already posts for tomorrow...');
    const existingPosts = await client.sql`
      SELECT 1
      FROM posts
      WHERE status = 'scheduled'
        AND platform LIKE '%/r/%'
        AND DATE(published_date) = CURRENT_DATE + INTERVAL '1 day';
    `;

    if (existingPosts.rows.length > 0) {
      console.log('   A post for tomorrow already exists. Aborting...');
      return [];
    } else {
      console.log('   No scheduled posts found for tomorrow. Proceeding...');
    }

    console.log('Step 2: Fetch the next book to publish...');
    const bookToPostResult = await client.sql`
      SELECT 
          b.id AS book_id,
          b.title AS book_title,
          b.cover AS book_cover,
          a.name AS author_name,
          COUNT(p.book_id) AS post_count
      FROM 
          books b
      LEFT JOIN 
          authors a
      ON 
          b.author_id = a.id
      LEFT JOIN 
          posts p
      ON 
          b.id = p.book_id AND p.platform LIKE '%/r/FreeEBOOKS/%'
      GROUP BY 
          b.id, b.title, b.cover, a.name
      ORDER BY 
          post_count ASC
      LIMIT 1;
      `;

    const bookToPost = bookToPostResult.rows; // Extract the rows array

    if (bookToPost.length === 0) {
      console.log('   No books available to schedule. Aborting...');
      return [];
    } else {
      console.log('   Next book to post:', bookToPost[0].book_title);
    }
    const item = bookToPost[0]; // Access the first item in the rows array

    console.log('Step 3: Build the post text dynamically ...');
    const postText = `${item.book_title} by ${item.author_name}`;

    console.log('Step 4: Insert the new post for tomorrow...');
    const data = await client.sql`
      INSERT INTO posts (book_id, text, image_link, platform, status, published_date)
      VALUES (
        ${item.book_id},
        ${postText},
        ${item.book_cover},
        '/r/FreeEBOOKS/',
        'scheduled',
        (CURRENT_DATE + INTERVAL '1 day')
      );
    `;

    console.log(`   Scheduled 1 post for tomorrow: Book ID ${item.book_id}, Text: "${postText}".`);
    return data.rows;
  }

  /**
 * Fetch the latest posts from a subreddit.
 * @param subreddit - The name of the subreddit (e.g., "javascript").
 * @param limit - The number of latest posts to fetch (default: 10).
 * @returns A promise that resolves to an array of posts.
 */
  async getLatestPosts(subreddit: string, limit: number = 10): Promise<snoowrap.Submission[]> {
    try {
      console.log(`Fetching latest ${limit} posts from subreddit: ${subreddit}`);

      const posts = await this.redditApi.getSubreddit(subreddit).getNew({ limit });

      console.log(`Fetched ${posts.length} posts from subreddit: ${subreddit}`);
      return posts;
    } catch (error) {
      console.error(`Failed to fetch posts from subreddit: ${subreddit}`, error);
      throw error;
    }
  }

  async publishScheduledPosts(): Promise<void> {
    try {
      const scheduledPosts = await fetchScheduledPosts();
      if (!scheduledPosts.length) {
        console.error('Reddit: No posts scheduled for today.');
      } else {
        console.log(`Reddit: Found ${scheduledPosts.length} scheduled posts for today.`);
      }

      for (const post of scheduledPosts) {
        try {

          await submitLinkWithFlair(this.redditApi, 'FreeEBOOKS', post.text, post.book_link, 'a0931564-ffaf-11e2-9318-12313b0cf20e', '');
          await updatePostStatus(post.id);
          console.log(`Reddit Link \"${post.text}\" published successfully.`);
        } catch (error) {
          if (error instanceof Error) {
            console.error(`Failed to publish post ID ${post.text}:`, error.message);
          } else {
            console.error(`Unpextected error while publishing post ID ${post.text}:`, error);
          }
          throw error; // Re-throw the error after logging         
        }
      }

    } catch (error) {
      if (error instanceof Error) {
        console.error('   Reddit: Error processing scheduled posts:', error.message);
      } else {
        console.error('   Reddit: An unexpected error processing scheduled posts::', error);
      }
      throw error; // Re-throw the error after logging 
    }
  }
}


// Called by the RedditClient class
async function fetchScheduledPosts() {
  const query = `
    SELECT 
        posts.*,
        books.link AS book_link
    FROM posts
    LEFT JOIN books ON posts.book_id = books.id
    WHERE posts.status = 'scheduled'
      AND posts.platform LIKE '%/r/FreeEBOOKS/%'
      AND DATE(posts.published_date) = CURRENT_DATE;
  `;

  try {
    console.log('Fetch Today Posts for /r/FreeEBOOKS/ ...');
    const result = await db.query(query);
    return result.rows;
  } catch (error) {
    if (error instanceof Error) {
      console.error('   Error fetching scheduled posts for Today:', error.message);
    } else {
      console.error('   Unkown error fetching scheduled posts for Today:', error);
    }
    throw error; // Re-throw the error after logging
  }
}


/**
 * Submits a link to Reddit with a specified flair.
 *
 * @param {snoowrap} redditClient - Snoowrap instance for Reddit API access.
 * @param {string} subreddit - The subreddit to post in.
 * @param {string} title - The title of the post.
 * @param {string} url - The URL to submit.
 * @param {string} flairId - The flair template ID to apply.
 * @param {string} flairText - Optional flair text (if allowed by the subreddit).
 * @returns {Promise<object|null>} A Promise resolving to the submission object or null if submission fails.
 */
async function submitLinkWithFlair(redditClient, subreddit, title, url, flairId, flairText) {
  try {
    const subredditObj = redditClient.getSubreddit(subreddit);

    // Prepare the options for the submission
    const options: any = {
      title: title,
      url: url,
      resubmit: false,
    };

    if (flairId) options.flairId = flairId;
    if (flairText) options.flairText = flairText;
    // Submit the link with flair
    const mySubmission = await subredditObj.submitLink(options);

    console.log(`Post submitted successfully: ${mySubmission.url}`);
    return mySubmission;
  } catch (error) {
    console.error('Error submitting post with flair:', error);
    return null;
  }
}

// TODO: This function also exists in app/cron/route.ts and should be moved to a shared module
// Update post status after successful publishing
async function updatePostStatus(postId: number) {
  const query = `
    UPDATE posts
    SET status = 'published'
    WHERE id = $1
  `;
  const values = [postId];

  try {
    await db.query(query, values);
    console.log(`Post ID ${postId} marked as published.`);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error updating post status for ID ${postId}:`, error.message);
    } else {
      console.error(`Unpextected Error updating post status for ID ${postId}:`, error);
    }
    throw error; // Re-throw the error after logging         

  }
}

// The main GET API route
export async function GET() {

  const redditClient = new RedditClient({
    clientId: process.env.REDDIT_CLIENT_ID || '',
    clientSecret: process.env.REDDIT_CLIENT_SECRET || '',
    username: process.env.REDDIT_USERNAME || '',
    password: process.env.REDDIT_PASSWORD || '',
    userAgent: process.env.REDDIT_USER_AGENT || '',
  });

  try {
    //const latestPosts = await redditClient.getLatestPosts('suggestmeabook', 10);
    //const latestPosts = await redditClient.schedulePost();
    const latestPosts = await redditClient.publishScheduledPosts();
    /*
    console.log('Latest Posts:', latestPosts.map(post => ({
      title: post.title,
      url: post.url,
    })));
    */

    return Response.json({ success: true, message: 'Fetched latest posts.', latestPosts });
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error fetching posts:', error.message);
      return Response.json({ success: false, message: error.message }, { status: 500 });
    } else {
      console.error('Unknown error fetching posts:', error);
      return Response.json({ success: false, message: 'An unknown error occurred.' }, { status: 500 });
    }
  }
}