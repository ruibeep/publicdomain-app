import { NextRequest, NextResponse } from 'next/server';
import { LinkedInClient } from '../../lib/socialMedia/LinkedInClient';

export async function GET(request: NextRequest) {
  try {
    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
    const orgId = process.env.LINKEDIN_ORG_ID;
    if (!accessToken) {
      return NextResponse.json({ success: false, error: 'LINKEDIN_ACCESS_TOKEN not set' }, { status: 500 });
    }
    if (!orgId) {
      return NextResponse.json({ success: false, error: 'LINKEDIN_ORG_ID not set' }, { status: 500 });
    }
    const client = new LinkedInClient(accessToken, orgId);
    // Example book link
    const bookLink = 'https://publicdomainlibrary.org/book/example';
    await client.commentOnLatestCompanyPost(bookLink);
    return NextResponse.json({ success: true, message: 'Tried to comment on latest company post with book link.' });
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: false, error: 'An unexpected error occurred' }, { status: 500 });
  }
}
