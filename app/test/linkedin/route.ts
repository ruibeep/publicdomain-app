import { NextRequest, NextResponse } from 'next/server';
import { LinkedInClient } from '../../lib/socialMedia/LinkedInClient';
import { db } from '@vercel/postgres';

export async function GET(request: NextRequest) {
  try {
    const orgId = process.env.LINKEDIN_ORG_ID;
    if (!orgId) {
      return NextResponse.json({ success: false, error: 'LINKEDIN_ORG_ID not set' }, { status: 500 });
    }
    
    const databaseClient = await db.connect();
    const client = new LinkedInClient(databaseClient, orgId);
    await client.initialize();
    
    // Test the commentPost method with a sample post ID and book link
    // Note: You'll need to replace this with a real LinkedIn post URN for testing
    const samplePostId = 'urn:li:activity:1234567890'; // Replace with actual post URN
    const bookLink = 'https://publicdomainlibrary.org/en/ebooks/dubliners';
    
    try {
      await client.commentPost(bookLink, samplePostId);
      return NextResponse.json({ 
        success: true, 
        message: 'Successfully tested commentPost method with book link.' 
      });
    } catch (commentError) {
      return NextResponse.json({ 
        success: false, 
        error: `Comment test failed: ${commentError instanceof Error ? commentError.message : 'Unknown error'}`,
        note: 'This is expected if the sample post ID is not valid. Replace with a real LinkedIn post URN for actual testing.'
      }, { status: 500 });
    }
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: false, error: 'An unexpected error occurred' }, { status: 500 });
  }
}
