import { NextResponse } from 'next/server';
import { FacebookClient } from '../../lib/socialMedia/FacebookClient';
import { db } from '@vercel/postgres';

export async function GET(request: Request) {
    try {
        const client = new FacebookClient({
            pageId: process.env.FACEBOOK_PAGE_ID || '',
            accessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
        });
        const databaseClient = await db.connect();

        // Test publishing scheduled Facebook posts for today
        await client.schedulePost(databaseClient);
        //await client.publishScheduledPosts(databaseClient);

        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof Error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 });
        }
        return NextResponse.json({ success: false, error: 'An unexpected error occurred' }, { status: 500 });
    }
}
