import { db } from '@vercel/postgres';
import { XClient, RedditClient, SocialMediaClient } from "../../lib/socialMedia";
import type { NextRequest } from 'next/server'


function createSocialMediaClient(platform: string): SocialMediaClient {
    switch (platform) {
        case 'reddit':
            console.log('Creating reddit Client ...');
            return new RedditClient({
                clientId: process.env.REDDIT_CLIENT_ID || '',
                clientSecret: process.env.REDDIT_CLIENT_SECRET || '',
                username: process.env.REDDIT_USERNAME || '',
                password: process.env.REDDIT_PASSWORD || '',
                userAgent: process.env.REDDIT_USER_AGENT || '',
            });
        case 'X':
            console.log('Creating X Client ...');
            return new XClient({
                appKey: process.env.X_API_KEY?.trim() || '',
                appSecret: process.env.X_KEY_SECRET?.trim() || '',
                accessToken: process.env.X_ACCESS_TOKEN?.trim() || '',
                accessSecret: process.env.X_ACCESS_TOKEN_SECRET?.trim() || '',
            });
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

async function schedulePostForPlatforms(platforms: string[], dbclient) {
    for (const platform of platforms) {
        const client = createSocialMediaClient(platform);
        console.log('Schedule Post For Platform: ', platform);
        await client.schedulePost(dbclient);
    }
}

async function publishScheduledPosts(platforms: string[], dbclient) {
    for (const platform of platforms) {
        const client = createSocialMediaClient(platform);
        console.log('Publish Posts for: ', platform);
        await client.publishScheduledPosts(dbclient);
    }
}



export async function GET(request: NextRequest) {
    const client = createSocialMediaClient('X');
    const databaseClient = await db.connect();
  
    try {
      console.time('⏱ Script runtime');
      const summary = await client.quarterHourly(databaseClient);
      console.timeEnd('⏱ Script runtime');
      
      const finishedAt = new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' });
      console.log(`⌚️ Script finished at ${finishedAt} Amsterdam time`);
      
      return Response.json({
        success: true,
        finishedAt,
        summary
      });
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