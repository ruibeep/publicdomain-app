import { NextResponse } from 'next/server';
import { FacebookClient } from '../../lib/socialMedia/FacebookClient';

export async function GET(request: Request) {
    try {
        const client = new FacebookClient({
            pageId: process.env.FACEBOOK_PAGE_ID || '',
            accessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
        });

        // Post a simple "Hello world" message
        const result = await client.postToFacebook('Hello world');

        return NextResponse.json({ success: true, result });
    } catch (error) {
        if (error instanceof Error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 });
        }
        return NextResponse.json({ success: false, error: 'An unexpected error occurred' }, { status: 500 });
    }
}
