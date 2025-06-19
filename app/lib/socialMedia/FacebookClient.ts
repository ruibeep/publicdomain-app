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
        const url = `https://graph.facebook.com/v19.0/${this.pageId}/feed`;
        
        // Check if we have the required permissions first
        try {
            const permissionsUrl = `https://graph.facebook.com/v19.0/${this.pageId}/permissions`;
            const permissionsResponse = await fetch(`${permissionsUrl}?access_token=${this.accessToken}`);
            const permissionsData = await permissionsResponse.json();
            
            const requiredPermissions = ['pages_read_engagement', 'pages_manage_posts'];
            const missingPermissions = requiredPermissions.filter(perm => 
                !permissionsData.data?.some(p => p.permission === perm && p.status === 'granted')
            );

            if (missingPermissions.length > 0) {
                throw new Error(`Missing required Facebook permissions: ${missingPermissions.join(', ')}. Please ensure your access token has these permissions.`);
            }
        } catch (error) {
            if (error instanceof Error) {
                console.error('Error checking Facebook permissions:', error.message);
                throw error;
            }
            throw new Error('Unexpected error while checking Facebook permissions');
        }

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
        console.log('Step 1: Check if there are already posts for tomorrow...');
        const existingPosts = await client.sql`
            SELECT 1
            FROM posts
            WHERE status = 'scheduled'
                AND platform = 'Facebook'
                AND DATE(published_date) = CURRENT_DATE + INTERVAL '1 day';
        `;

        if (existingPosts.rows.length > 0) {
            console.log('   A post for tomorrow already exists. Aborting...');
            return [];
        }

        console.log('Step 2: Fetch the next book to publish...');
        const bookToPostResult = await client.sql`
            SELECT 
                b.id AS book_id,
                b.title AS book_title,
                b.cover AS book_cover,
                a.name AS author_name
            FROM 
                books b
            LEFT JOIN 
                authors a ON b.author_id = a.id
            LEFT JOIN 
                posts p ON b.id = p.book_id AND p.platform = 'Facebook'
            GROUP BY 
                b.id, b.title, b.cover, a.name
            ORDER BY 
                COUNT(p.book_id) ASC
            LIMIT 1;
        `;

        if (bookToPostResult.rows.length === 0) {
            console.log('   No books available to schedule. Aborting...');
            return [];
        }

        const item = bookToPostResult.rows[0];
        const postText = `${item.book_title} by ${item.author_name}`;

        console.log('Step 3: Insert the new post for tomorrow...');
        const data = await client.sql`
            INSERT INTO posts (book_id, text, image_link, platform, status, published_date)
            VALUES (
                ${item.book_id},
                ${postText},
                ${item.book_cover},
                'Facebook',
                'scheduled',
                (CURRENT_DATE + INTERVAL '1 day')
            );
        `;

        console.log(`   Scheduled 1 post for tomorrow: Book ID ${item.book_id}, Text: "${postText}".`);
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
                    await this.postToFacebook(post.text, post.image_link);
                    await this.updatePostStatus(client, post.id);
                    console.log(`Facebook post "${post.text}" published successfully.`);
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