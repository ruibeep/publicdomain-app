import { db } from '@vercel/postgres';
import { XClient, RedditClient, SocialMediaClient, LinkedInClient, FacebookClient } from "../../lib/socialMedia";
import type { NextRequest } from 'next/server'

async function createSocialMediaClient(platform: string, dbclient: any): Promise<SocialMediaClient> {
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
        case 'LinkedIn':
            console.log('Creating LinkedIn Client ...');
            const linkedInClient = new LinkedInClient(
                dbclient,
                process.env.LINKEDIN_ORG_ID || ''
            );
            // Initialize the client to load access token from database
            await linkedInClient.initialize();
            return linkedInClient;
        case 'Facebook':
            console.log('Creating Facebook Client ...');
            return new FacebookClient({
                pageId: process.env.FACEBOOK_PAGE_ID || '',
                accessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
            });
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

async function schedulePostForPlatforms(platforms: string[], dbclient) {
    for (const platform of platforms) {
        const client = await createSocialMediaClient(platform, dbclient);
        console.log('Schedule Post For Platform: ', platform);
        await client.schedulePost(dbclient);
    }
}

async function publishScheduledPosts(platforms: string[], dbclient) {
    for (const platform of platforms) {
        const client = await createSocialMediaClient(platform, dbclient);
        console.log('Publish Posts for: ', platform);
        await client.publishScheduledPosts(dbclient);
    }
}

// The main GET API route
export async function GET(request: NextRequest) { 
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response('Unauthorized', {
            status: 401,
        });
    }

    const databaseClient = await db.connect();
    const platforms = ['X', 'reddit', 'LinkedIn', 'Facebook']; // Add more platforms as needed
    // const platforms = ['LinkedIn'];
    try {
        await schedulePostForPlatforms(platforms, databaseClient);
        await publishScheduledPosts(platforms, databaseClient);

        return Response.json({ success: true, message: 'Fetched latest posts.' });
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