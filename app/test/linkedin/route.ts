import { NextRequest, NextResponse } from 'next/server';
import { LinkedInClient } from '../../lib/socialMedia/LinkedInClient';
import { db } from '@vercel/postgres';

export async function POST(request: NextRequest) {
  try {
    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
    const orgId = process.env.LINKEDIN_ORG_ID;
    const imageUrl = "https://publicdomainlibrary.org/uploads/attachments/zlgapihcwxvo7gw5hqfmfz79-screenshot-2025-05-09-at-11-36-04.max.png";

    if (!accessToken) {
      return NextResponse.json({ error: 'LinkedIn access token not configured' }, { status: 500 });
    }
    if (!orgId) {
      return NextResponse.json({ error: 'LinkedIn organization ID not configured' }, { status: 500 });
    }

    const linkedInClient = new LinkedInClient(accessToken, orgId);
    const data = await linkedInClient.postWithImage(
      'hello world from the company page with an image!',
      imageUrl
    );

    return NextResponse.json(
      { success: true, message: 'Successfully posted with image to the LinkedIn company page', data },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Unexpected error', details: error instanceof Error ? error.message : error },
      { status: 500 }
    );
  }
}

export async function GET() {
  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORG_ID;
  return NextResponse.json(
    {
      message: 'LinkedIn test endpoint. Use POST to send a post with an image to the LinkedIn company page.',
      requiredEnvVars: [
        'LINKEDIN_ACCESS_TOKEN',
        'LINKEDIN_ORG_ID'
      ],
      envStatus: {
        accessToken: accessToken ? 'Set' : 'Not set',
        orgId: orgId ? `Set (${orgId})` : 'Not set'
      }
    },
    { status: 200 }
  );
}

// New endpoint: /test/linkedin/schedule
export async function PUT(request: NextRequest) {
  try {
    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
    const orgId = process.env.LINKEDIN_ORG_ID;
    if (!accessToken) {
      return NextResponse.json({ error: 'LinkedIn access token not configured' }, { status: 500 });
    }
    if (!orgId) {
      return NextResponse.json({ error: 'LinkedIn organization ID not configured' }, { status: 500 });
    }
    const dbclient = await db.connect();
    const linkedInClient = new LinkedInClient(accessToken, orgId);
    const result = await linkedInClient.schedulePost(dbclient);
    return NextResponse.json({ success: true, message: 'Scheduled LinkedIn post for tomorrow', result }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Unexpected error', details: error instanceof Error ? error.message : error }, { status: 500 });
  }
}

// PATCH: publish scheduled posts
export async function PATCH(request: NextRequest) {
  try {
    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
    const orgId = process.env.LINKEDIN_ORG_ID;
    if (!accessToken) {
      return NextResponse.json({ error: 'LinkedIn access token not configured' }, { status: 500 });
    }
    if (!orgId) {
      return NextResponse.json({ error: 'LinkedIn organization ID not configured' }, { status: 500 });
    }
    const dbclient = await db.connect();
    const linkedInClient = new LinkedInClient(accessToken, orgId);
    await linkedInClient.publishScheduledPosts(dbclient);
    return NextResponse.json({ success: true, message: 'Published scheduled LinkedIn posts for today' }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Unexpected error', details: error instanceof Error ? error.message : error }, { status: 500 });
  }
}
