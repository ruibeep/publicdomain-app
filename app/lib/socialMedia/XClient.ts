import { VercelPoolClient } from "@vercel/postgres";
import { BaseSocialMediaClient, SocialMediaClient } from "./SocialMediaClient";
import { TwitterApi } from 'twitter-api-v2';

export class XClient extends BaseSocialMediaClient implements SocialMediaClient {
    protected platform = 'X';
    private XApi: TwitterApi;

    constructor(apiConfig: { appKey: string; appSecret: string; accessToken: string; accessSecret: string }) {
        super();
        // Initialize Twitter client with OAuth 1.0a credentials
        this.XApi = new TwitterApi({
            appKey: apiConfig.appKey,
            appSecret: apiConfig.appSecret,
            accessToken: apiConfig.accessToken,
            accessSecret: apiConfig.accessSecret,
        });
    }

    async schedulePost(client: VercelPoolClient): Promise<any[]> {
        console.log('Step 1: Check if there are already posts for tomorrow...');
        const existingPosts = await client.sql`
          SELECT 1
          FROM posts
          WHERE status = 'scheduled'
            AND platform LIKE '%X%'
            AND DATE(published_date) = CURRENT_DATE + INTERVAL '1 day';
        `;

        if (existingPosts.rows.length > 0) {
            console.log('   A post for tomorrow already exists. Aborting...');
            return [];
        } else {
            console.log('   No scheduled posts found for tomorrow. Proceeding...');
        }

        console.log('Step 2: Fetch the next quote to publish...');
        // Used ChatGPT for creating this SQL query.
        // https://chatgpt.com/share/677d0a6c-a840-8010-8815-5ad1b9226577
        const quoteToPostResult = await client.sql`
          WITH book_quote_counts AS (
            SELECT
              b.id AS book_id,
              b.title AS book_title,
              b.cover AS book_cover,
              a.name AS author_name,
              COUNT(p.id) AS book_post_count
            FROM
              books b
              JOIN authors a ON b.author_id = a.id
              LEFT JOIN quotes q ON b.id = q.book_id
              LEFT JOIN posts p ON q.id = p.quote_id
            GROUP BY
              b.id, b.title, b.cover, a.name
          ),
          quote_post_counts AS (
            SELECT
              q.id AS quote_id,
              q.quote,
              q.popularity,
              q.book_id,
              COUNT(p.id) AS quote_post_count
            FROM
              quotes q
              LEFT JOIN posts p ON q.id = p.quote_id
            GROUP BY
              q.id, q.quote, q.popularity, q.book_id
          ),
          filtered_books AS (
            SELECT
              bq.book_id,
              bq.book_title,
              bq.book_cover,
              bq.author_name,
              MIN(qpc.quote_post_count) AS min_quote_post_count,
              bq.book_post_count
            FROM
              book_quote_counts bq
              JOIN quote_post_counts qpc ON bq.book_id = qpc.book_id
            GROUP BY
              bq.book_id, bq.book_title, bq.book_cover, bq.author_name, bq.book_post_count
            ORDER BY
              bq.book_post_count ASC
          ),
          final_quotes AS (
            SELECT
              qpc.quote_id,
              qpc.quote,
              qpc.book_id,
              fb.book_title,
              fb.book_cover,
              fb.author_name,
              qpc.popularity
            FROM
              filtered_books fb
              JOIN quote_post_counts qpc ON fb.book_id = qpc.book_id
            WHERE
              qpc.quote_post_count = fb.min_quote_post_count
            ORDER BY
              fb.book_post_count ASC,
              qpc.quote_post_count ASC,
              qpc.popularity DESC
          )
          SELECT
            quote_id,
            quote,
            book_id,
            book_title,
            book_cover,
            author_name,
            popularity
          FROM
            final_quotes
          LIMIT 1;
        `;

        const quoteToPost = quoteToPostResult.rows; // Extract the rows array
        if (quoteToPost.length === 0) {
            console.log('   No quotes available to schedule. Aborting...');
            return [];
        } else {
            console.log('   Next Quote to post:', quoteToPost[0].quote);
        }

        console.log('Step 3: Build the post text dynamically ...');
        const item = quoteToPost[0]; // Access the first item in the rows array
        const postText = `"${item.quote}" - ${item.book_title} by ${item.author_name} #ebooks #mustread #booklovers #book #ReadersCommunity #bookrecommendations #kindlebooks #ClassicLitMonday #BookologyThursday`;
        console.log('  Post text:', postText);

        console.log('Step 4: Insert the new post for tomorrow ...');
        const data = await client.sql`
          INSERT INTO posts (quote_id, text, image_link, platform, status, published_date)
          VALUES (
            ${item.quote_id},
            ${postText},
            ${item.book_cover},
            'X',
            'scheduled',
            (CURRENT_DATE + INTERVAL '1 day')
          );
        `;

        console.log(`   Scheduled 1 post for tomorrow: Quote ID ${item.quote_id}, Text: "${postText}".`);
        return data.rows;
    }

    async publishScheduledPosts(client: VercelPoolClient): Promise<void> {
        try {
            console.log('Fetching scheduled posts...');
            const scheduledPosts = await this.fetchScheduledPosts(client);
            console.log('Fetch scheduled posts done.');

            if (!scheduledPosts.length) {
                console.error('No posts scheduled for today.');
            }

            console.log(`Found ${scheduledPosts.length} posts for today. Posting...`);

            for (const post of scheduledPosts) {
                try {
                    await this.postToTwitter(post.text, post.image_link);
                    await this.updatePostStatus(client, post.id);
                    console.log(`Post ID ${post.id} published successfully.`);
                } catch (error) {
                    if (error instanceof Error) {
                        console.error(`Failed to publish post ID ${post.id}:`, error.message);
                    } else {
                        console.error(`Unpextected error while publishing post ID ${post.id}:`, error);
                    }
                    throw error; // Re-throw the error after logging         
                }
            }

            console.log('All posts scheduled for today have been processed.');
        } catch (error) {
            if (error instanceof Error) {
                console.error('Error processing scheduled posts:', error.message);
            } else {
                console.error('An unexpected error processing scheduled posts::', error);
            }
            throw error; // Re-throw the error after logging 
        }
    }

    // Post a single quote to Twitter
    async postToTwitter(text: string, imageLink?: string | null) {
        try {
            if (imageLink) {
                console.log('Downloading image...');
                const imageBuffer = await this.downloadImage(imageLink);

                console.log('Uploading image to Twitter...');
                const mediaId = await this.XApi.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });

                // Post with media
                console.log('Making the post...');
                // const response = await twitterClient.v2.tweet(text, { media_ids: [mediaId] });
                const response = await this.XApi.v2.tweet({ text: text, media: { media_ids: [mediaId] } });


                console.log('Successfully posted with image:', response);
                return response;
            } else {
                // Post text-only tweet
                const response = await this.XApi.v2.tweet(text);
                console.log('Successfully posted:', response);
                return response;
            }
        } catch (error) {
            if (error instanceof Error) {
                console.error('Error fetching scheduled posts:', error.message);
            } else {
                console.error('An unexpected error occurred:', error);
            }
            throw error; // Re-throw the error after logging
        }
    }

    // Download an image from a URL
    async downloadImage(url: string): Promise<Buffer> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
        }
        return Buffer.from(await response.arrayBuffer());
    }
}

