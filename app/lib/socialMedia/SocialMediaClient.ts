import { VercelPoolClient } from "@vercel/postgres";

export interface SocialMediaClient {
  replyToAllBookMentions(databaseClient: VercelPoolClient): unknown;
  schedulePost(client: VercelPoolClient): Promise<any[]>;
  publishScheduledPosts(client: VercelPoolClient): Promise<void>;
}

export abstract class BaseSocialMediaClient {
  protected abstract platform: string;

  // Shared method: Fetch scheduled posts
  async fetchScheduledPosts(client: VercelPoolClient): Promise<any[]> {
      try {
        console.log('Fetch Today Posts for ', this.platform, ' ...');
        const result = await client.sql`
          SELECT 
              posts.id AS id,
              posts.text,
              posts.image_link,
              posts.platform,
              posts.published_date,
              COALESCE(books_direct.link, books_via_quote.link) AS book_link
          FROM 
              posts
          -- Direct join if the post has a book_id
          LEFT JOIN 
              books AS books_direct ON posts.book_id = books_direct.id
          -- Join via quotes if the post has a quote_id
          LEFT JOIN 
              quotes ON posts.quote_id = quotes.id
          LEFT JOIN 
              books AS books_via_quote ON quotes.book_id = books_via_quote.id
          WHERE 
              posts.status = 'scheduled'
              AND posts.platform = ${this.platform}
              AND DATE(posts.published_date) = CURRENT_DATE;
        `;    
        return result.rows;
    } catch (error) {
        if (error instanceof Error) {
            console.error('   Error fetching scheduled posts for Today:', error.message);
        } else {
            console.error('   Unkown error fetching scheduled posts for Today:', error);
        }
        throw error; // Re-throw the error after logging
    }
  }

  // Shared method: Update post status
  async updatePostStatus(client: VercelPoolClient, postId: number): Promise<void> {
    const query = `
      UPDATE posts
      SET status = 'published'
      WHERE id = $1
    `;
    await client.query(query, [postId]);
    console.log(`Post ID ${postId} marked as published.`);
  }
}