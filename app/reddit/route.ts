import { db } from '@vercel/postgres';
import { RedditClient } from "../lib/socialMedia";

const client = await db.connect();

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
    const latestPosts = await redditClient.publishScheduledPosts(client);
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