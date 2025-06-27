import { VercelPoolClient } from "@vercel/postgres";
import { BaseSocialMediaClient, SocialMediaClient } from "./SocialMediaClient";

export class FacebookClient extends BaseSocialMediaClient implements SocialMediaClient {
    protected platform = 'Facebook';
    private pageId: string;
    private accessToken: string;

    constructor(apiConfig: { pageId: string; accessToken: string }) {
        super();
        this.pageId = apiConfig.pageId;
        this.accessToken = apiConfig.accessToken;
    }

    async postToFacebook(text: string, imageUrl?: string): Promise<any> {
        const url = `https://graph.facebook.com/v22.0/${this.pageId}/feed`;

        const body: any = {
            message: text,
            access_token: this.accessToken,
        };

        if (imageUrl) {
            body.link = imageUrl;
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(`Facebook API Error: ${JSON.stringify(error)}`);
            }

            return await response.json();
        } catch (error) {
            if (error instanceof Error) {
                console.error('Error posting to Facebook:', error.message);
            } else {
                console.error('Unexpected error posting to Facebook:', error);
            }
            throw error;
        }
    }

    // Required interface methods
    async quarterHourly(client: VercelPoolClient): Promise<void> {
        // Not implemented for Facebook
    }

    async schedulePost(client: VercelPoolClient): Promise<any[]> {
        console.log('Step 1: Check if there are already Facebook posts scheduled for tomorrow...');
        const existingPosts = await client.sql`
            SELECT 1
            FROM posts
            WHERE status = 'scheduled'
                AND platform = 'Facebook'
                AND DATE(published_date) = CURRENT_DATE + INTERVAL '1 day';
        `;

        if (existingPosts.rows.length > 0) {
            console.log('   A Facebook post for tomorrow already exists. Aborting...');
            return [];
        } else {
            console.log('   No scheduled Facebook posts found for tomorrow. Proceeding...');
        }

        console.log('Step 2: Fetch the next quote to publish...');
        const quoteToPostResult = await client.sql`
            WITH book_quote_counts AS (
                SELECT
                    b.id AS book_id,
                    b.title AS book_title,
                    b.cover AS book_cover,
                    a.name AS author_name,
                    COUNT(p.id) AS book_post_count
                FROM books b
                JOIN authors a ON b.author_id = a.id
                LEFT JOIN quotes q ON b.id = q.book_id
                LEFT JOIN posts p ON q.id = p.quote_id AND p.platform = 'Facebook'
                GROUP BY b.id, b.title, b.cover, a.name
            ),
            quote_post_counts AS (
                SELECT
                    q.id AS quote_id,
                    q.quote,
                    q.popularity,
                    q.book_id,
                    COUNT(p.id) AS quote_post_count
                FROM quotes q
                LEFT JOIN posts p ON q.id = p.quote_id AND p.platform = 'Facebook'
                GROUP BY q.id, q.quote, q.popularity, q.book_id
            ),
            filtered_books AS (
                SELECT
                    bq.book_id,
                    bq.book_title,
                    bq.book_cover,
                    bq.author_name,
                    MIN(qpc.quote_post_count) AS min_quote_post_count,
                    bq.book_post_count
                FROM book_quote_counts bq
                JOIN quote_post_counts qpc ON bq.book_id = qpc.book_id
                GROUP BY bq.book_id, bq.book_title, bq.book_cover, bq.author_name, bq.book_post_count
                ORDER BY bq.book_post_count ASC
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
                FROM filtered_books fb
                JOIN quote_post_counts qpc ON fb.book_id = qpc.book_id
                WHERE qpc.quote_post_count = fb.min_quote_post_count
                ORDER BY fb.book_post_count ASC, qpc.quote_post_count ASC, qpc.popularity DESC
            )
            SELECT
                quote_id,
                quote,
                book_id,
                book_title,
                book_cover,
                author_name,
                popularity
            FROM final_quotes
            LIMIT 1;
        `;

        const quoteToPost = quoteToPostResult.rows;
        if (!quoteToPost.length) {
            console.log('   No quotes available to schedule. Aborting...');
            return [];
        } else {
            console.log('   Next Quote to post:', quoteToPost[0].quote);
        }

        console.log('Step 3: Build the post text dynamically ...');
        const item = quoteToPost[0];
        const postText = `"${item.quote}" - ${item.book_title} by ${item.author_name}`;
        console.log('  Post text:', postText);

        console.log('Step 4: Insert the new Facebook post for tomorrow ...');
        const data = await client.sql`
            INSERT INTO posts (quote_id, book_id, text, image_link, platform, status, published_date)
            VALUES (
                ${item.quote_id},
                ${item.book_id},
                ${postText},
                ${item.book_cover},
                'Facebook',
                'scheduled',
                (CURRENT_DATE + INTERVAL '1 day')
            )
            RETURNING id;
        `;

        console.log(`   Scheduled 1 Facebook post for tomorrow: Quote ID ${item.quote_id}, Text: "${postText}".`);
        return data.rows;
    }

    async publishScheduledPosts(client: VercelPoolClient): Promise<void> {
        try {
            const scheduledPosts = await this.fetchScheduledPosts(client);
            
            if (!scheduledPosts.length) {
                console.log('Facebook: No posts scheduled for today.');
                return;
            }

            console.log(`Facebook: Found ${scheduledPosts.length} posts for today.`);

            for (const post of scheduledPosts) {
                try {
                    let postResult;
                    if (post.image_link) {
                        // 1. Upload the image to the page
                        const photoRes = await fetch(
                            `https://graph.facebook.com/v22.0/${this.pageId}/photos?published=false&access_token=${this.accessToken}`,
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    url: post.image_link,
                                    published: false,
                                    caption: post.text,
                                    access_token: this.accessToken,
                                }),
                            }
                        );
                        const photoData = await photoRes.json();
                        if (!photoRes.ok || !photoData.id) {
                            throw new Error(`Failed to upload photo: ${JSON.stringify(photoData)}`);
                        }

                        // 2. Create the post with the uploaded photo
                        const feedRes = await fetch(
                            `https://graph.facebook.com/v22.0/${this.pageId}/feed`,
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    message: post.text,
                                    attached_media: [{ media_fbid: photoData.id }],
                                    access_token: this.accessToken,
                                }),
                            }
                        );
                        postResult = await feedRes.json();
                        if (!feedRes.ok) {
                            throw new Error(`Failed to create post with image: ${JSON.stringify(postResult)}`);
                        }
                    } else {
                        // No image, just post text
                        postResult = await this.postToFacebook(post.text);
                    }

                    await this.updatePostStatus(client, post.id);
                    console.log(`Facebook post "${post.text}" published successfully.`);

                    // Add a comment with the book link if available
                    if (post.book_link && postResult && postResult.id) {
                        // Add UTM parameters to the book link for tracking
                        const utmLink = `${post.book_link}?utm_source=facebook.com&utm_medium=referral&utm_campaign=facebook-scheduled-posts`;
                        const commentRes = await fetch(
                            `https://graph.facebook.com/v22.0/${postResult.id}/comments`,
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    message: `Download the ebook for free: ${utmLink}`,
                                    access_token: this.accessToken,
                                }),
                            }
                        );
                        const commentData = await commentRes.json();
                        if (!commentRes.ok) {
                            console.error('Failed to comment on Facebook post:', commentData);
                        } else {
                            console.log('✅ Successfully commented on Facebook post:', commentData);
                        }
                    }
                } catch (error) {
                    if (error instanceof Error) {
                        console.error(`Failed to publish post ID ${post.id}:`, error.message);
                    } else {
                        console.error(`Unexpected error while publishing post ID ${post.id}:`, error);
                    }
                    throw error;
                }
            }
        } catch (error) {
            if (error instanceof Error) {
                console.error('Facebook: Error processing scheduled posts:', error.message);
            } else {
                console.error('Facebook: An unexpected error processing scheduled posts:', error);
            }
            throw error;
        }
    }
} 