const snoowrap = require('snoowrap');
const { NextResponse } = require('next/server');

import { db } from '@vercel/postgres';

const client = await db.connect();

async function schedulePost(){
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


async function getLatestPosts(redditClient, subreddit, limit = 10) {
  try {
    // Get the subreddit object
    const subredditObj = redditClient.getSubreddit(subreddit);

    // Fetch the latest posts (default sorting is 'new')
    const posts = await subredditObj.getNew({ limit });

    // Map the results to include only essential details
    const formattedPosts = posts.map(post => ({
      title: post.title,
      url: post.url,
      author: post.author.name,
      created_utc: post.created_utc,
      id: post.id,
    }));

    console.log(`Fetched ${formattedPosts.length} posts from /r/${subreddit}`);
    return formattedPosts;
  } catch (error) {
    console.error('Error fetching posts:', error);
    return null;
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
    const options : any = {
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

// The main GET API route
export async function GET() {
  const redditClient = new snoowrap({
    userAgent: process.env.REDDIT_USER_AGENT || '',
    clientId: process.env.REDDIT_CLIENT_ID || '',
    clientSecret: process.env.REDDIT_CLIENT_SECRET || '',
    username: process.env.REDDIT_USERNAME || '',
    password: process.env.REDDIT_PASSWORD || '',
  });

  const subreddit = 'FreeEBOOKS';
  const linkTitle = 'Crime and Punishment by Fyodor Dostoevsky';
  const linkUrl = 'https://publicdomainlibrary.org/en/books/crime-and-punishment';
  const flairId = 'a0931564-ffaf-11e2-9318-12313b0cf20e'; // Replace with the correct flair template ID

  try {
    const submission = await schedulePost();
    /*
    // Submit a new post
    const submission = await submitLinkWithFlair(
      redditClient,
      subreddit,
      linkTitle,
      linkUrl,
      flairId,
      ''   
      );     
    // Fetch the latest posts from the subreddit
    const latestPosts = await getLatestPosts(redditClient, 'suggestmeabook');

    return NextResponse.json({
      success: true,
      data: latestPosts,
    });
 


*/
    if (submission) {
      return NextResponse.json({
        success: true,
        message: 'Post submitted successfully!',
        // submissionUrl: submission.url,
      });
    } else {
      return NextResponse.json({
        success: false,
        message: 'Failed to submit the post.',
      });
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'An error occurred while processing the request.',
        error: error.message,
      },
      { status: 500 }
    );
       
  }
}