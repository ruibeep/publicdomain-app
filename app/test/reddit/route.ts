import { db } from '@vercel/postgres';
import { RedditClient, SocialMediaClient } from "../../lib/socialMedia";
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

function createSocialMediaClient(platform: string): SocialMediaClient {
  switch (platform) {
    case 'reddit':
      return new RedditClient({
        clientId: process.env.REDDIT_CLIENT_ID || '',
        clientSecret: process.env.REDDIT_CLIENT_SECRET || '',
        username: process.env.REDDIT_USERNAME || '',
        password: process.env.REDDIT_PASSWORD || '',
        userAgent: process.env.REDDIT_USER_AGENT || '',
      });
    /*
    case 'twitter':
      return new TwitterClient({
        appKey: process.env.TWITTER_API_KEY || '',
        appSecret: process.env.TWITTER_API_SECRET || '',
        accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
        accessSecret: process.env.TWITTER_ACCESS_SECRET || '',
      });
      */      
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

async function schedulePostForPlatforms(platforms: string[], dbclient) {
  for (const platform of platforms) {
    const client = createSocialMediaClient(platform);
    await client.schedulePost(dbclient);
  }
}

async function publishScheduledPosts(platforms: string[], dbclient) {
  for (const platform of platforms) {
    const client = createSocialMediaClient(platform);
    await client.publishScheduledPosts(dbclient);
  }
}

// The main GET API route
export async function GET() {
  const databaseClient = await db.connect();
  const platforms = ['reddit']; // Add more platforms as needed
  const client = createSocialMediaClient(platforms[0]) as RedditClient; 

  try {
    //await schedulePostForPlatforms(platforms, databaseClient);
    //await publishScheduledPosts(platforms, databaseClient);
    const answer = await client.quarterHourly(databaseClient);

    return Response.json({ success: true, message: answer });
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

/*
// The main GET API route
export async function GET() {
  const databaseClient = await db.connect();
  const platforms = ['reddit']; // Add more platforms as needed
  
  try {
    await schedulePostForPlatforms(platforms, databaseClient);
    await publishScheduledPosts(platforms, databaseClient);

    return Response.json({ success: true, message: 'Fetched latest posts.'});
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
*/