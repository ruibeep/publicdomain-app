import { VercelPoolClient } from "@vercel/postgres";
import { BaseSocialMediaClient, SocialMediaClient } from "./SocialMediaClient";
import { RestliClient } from 'linkedin-api-client';

export class LinkedInClient extends BaseSocialMediaClient implements SocialMediaClient {
  protected platform = 'LinkedIn';
  private linkedInApi: RestliClient;
  private accessToken: string;
  private orgId: string;

  constructor(accessToken: string, orgId: string) {
    super();
    this.accessToken = accessToken;
    this.orgId = orgId;
    this.linkedInApi = new RestliClient();
  }

  /**
   * ---------------------------------------------------------
   *  QUARTER-HOURLY (Runs Every 15 Min)
   * ---------------------------------------------------------
   */
  public async quarterHourly(client: VercelPoolClient): Promise<unknown> {
    console.log('LinkedIn quarterHourly called - no specific implementation needed');
    return { message: 'LinkedIn quarterHourly completed' };
  }

  /**
   * ---------------------------------------------------------
   *  SCHEDULE POST (similar to XClient)
   * ---------------------------------------------------------
   */
  public async schedulePost(client: VercelPoolClient): Promise<any[]> {
    console.log('Step 1: Check if there are already LinkedIn posts scheduled for tomorrow...');
    const existingPosts = await client.sql`
      SELECT 1
      FROM posts
      WHERE status = 'scheduled'
        AND platform LIKE '%LinkedIn%'
        AND DATE(published_date) = CURRENT_DATE + INTERVAL '1 day';
    `;

    if (existingPosts.rows.length > 0) {
      console.log('   A LinkedIn post for tomorrow already exists. Aborting...');
      return [];
    } else {
      console.log('   No scheduled LinkedIn posts found for tomorrow. Proceeding...');
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
        FROM quotes q
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
        FROM book_quote_counts bq
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
        FROM filtered_books fb
        JOIN quote_post_counts qpc ON fb.book_id = qpc.book_id
        WHERE qpc.quote_post_count = fb.min_quote_post_count
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

    console.log('Step 4: Insert the new LinkedIn post for tomorrow ...');
    const data = await client.sql`
      INSERT INTO posts (quote_id, book_id, text, image_link, platform, status, published_date)
      VALUES (
        ${item.quote_id},
        ${item.book_id},
        ${postText},
        ${item.book_cover},
        'LinkedIn',
        'scheduled',
        (CURRENT_DATE + INTERVAL '1 day')
      )
      RETURNING id;
    `;

    console.log(`   Scheduled 1 LinkedIn post for tomorrow: Quote ID ${item.quote_id}, Text: "${postText}".`);
    return data.rows;
  }

  /**
   * ---------------------------------------------------------
   *  PUBLISH SCHEDULED POSTS (similar to XClient)
   * ---------------------------------------------------------
   */
  public async publishScheduledPosts(client: VercelPoolClient): Promise<void> {
    try {
      console.log('Publishing scheduled LinkedIn posts...');
      const scheduledPosts = await this.fetchScheduledPosts(client);
      if (!scheduledPosts.length) {
        console.log('No posts scheduled for today.');
        return;
      }
      console.log(`Found ${scheduledPosts.length} posts for today. Posting...`);
      for (const post of scheduledPosts) {
        try {
          let postResponse;
          let postUrn;
          if (post.image_link) {
            postResponse = await this.postWithImage(post.text, post.image_link);
            // postWithImage returns the LinkedIn API response, which should contain the URN
            postUrn = postResponse.id || postResponse.urn || postResponse.activity || postResponse.entityUrn || postResponse["id"];
          } else {
            postResponse = await this.postToLinkedIn(post.text);
            // postToLinkedIn does not currently return the URN, so we need to update it to return the LinkedIn post URN
            postUrn = postResponse && (postResponse.id || postResponse.urn || postResponse.activity || postResponse.entityUrn || postResponse["id"]);
          }
          await this.updatePostStatus(client, post.id);
          // Use book_link from the scheduled post (already joined in fetchScheduledPosts)
          if (post.book_link && postUrn) {
            await this.commentPost(post.book_link, postUrn);
          } else if (!postUrn) {
            console.warn('Could not determine LinkedIn post URN for commenting.');
          }
          console.log(`✅ Published LinkedIn post ID: ${post.id}`);
        } catch (error) {
          console.error(`❌ Failed to publish LinkedIn post ID ${post.id}:`, error);
        }
      }
      console.log('All scheduled LinkedIn posts for today have been processed.');
    } catch (error) {
      console.error('Error publishing scheduled LinkedIn posts:', error);
      throw error;
    }
  }

  /**
   * ---------------------------------------------------------
   *  POST TO LINKEDIN (with optional image upload)
   * ---------------------------------------------------------
   */
  public async postToLinkedIn(text: string, imageLink?: string | null): Promise<any> {
    try {
      console.log('Posting to LinkedIn:', text);
      let mediaAssetUrn: string | undefined = undefined;
      if (imageLink) {
        // 1. Register the image upload
        const registerRes = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            registerUploadRequest: {
              owner: `urn:li:organization:${this.orgId}`,
              recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
              serviceRelationships: [
                {
                  identifier: 'urn:li:userGeneratedContent',
                  relationshipType: 'OWNER'
                }
              ],
              supportedUploadMechanism: ['SYNCHRONOUS_UPLOAD']
            }
          })
        });
        const registerData = await registerRes.json();
        if (!registerRes.ok) {
          throw new Error(`Failed to register image upload: ${JSON.stringify(registerData)}`);
        }
        const uploadUrl = registerData.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
        mediaAssetUrn = registerData.value.asset;

        // 2. Download the image and upload to LinkedIn
        const imageBuffer = await this.downloadImage(imageLink);
        const uploadRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'image/png'
          },
          body: imageBuffer
        });
        if (!uploadRes.ok) {
          const uploadErr = await uploadRes.text();
          throw new Error(`Failed to upload image to LinkedIn: ${uploadErr}`);
        }
      }

      // 3. Create the post referencing the asset URN if present
      const postBody: any = {
        author: `urn:li:organization:${this.orgId}`,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text },
            shareMediaCategory: mediaAssetUrn ? 'IMAGE' : 'NONE',
            ...(mediaAssetUrn && {
              media: [
                {
                  status: 'READY',
                  description: { text: 'Image post' },
                  media: mediaAssetUrn,
                  title: { text: 'Image' }
                }
              ]
            })
          }
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
        }
      };

      const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(postBody)
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(`Failed to post to LinkedIn: ${JSON.stringify(data)}`);
      }
      console.log('✅ Successfully posted to LinkedIn');
      return data;
    } catch (error) {
      console.error('❌ Error posting to LinkedIn:', error);
      throw error;
    }
  }

  /**
   * ---------------------------------------------------------
   *  SIMPLE POST METHOD FOR TESTING
   * ---------------------------------------------------------
   */
  public async postSimpleMessage(message: string): Promise<void> {
    try {
      console.log('Posting simple message to LinkedIn:', message);
      
      // Try using the LinkedIn Share API instead
      const shareData = {
        owner: `urn:li:person:${process.env.LINKEDIN_PERSON_ID}`,
        subject: 'Test Post',
        text: {
          text: message
        }
      };

      console.log('Share data:', JSON.stringify(shareData, null, 2));

      // Try the share endpoint first
      try {
        const response = await this.linkedInApi.create({
          resourcePath: '/v2/shares',
          entity: shareData,
          accessToken: this.accessToken
        });
        
        console.log('✅ Successfully posted simple message to LinkedIn using shares API');
        console.log('Response:', response);
        return;
      } catch (shareError) {
        console.log('Share API failed, trying UGC Posts API...');
        
        // Fallback to UGC Posts API
        const postData = {
          author: `urn:li:person:${process.env.LINKEDIN_PERSON_ID}`,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: {
                text: message
              },
              shareMediaCategory: 'NONE'
            }
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
          }
        };

        console.log('Post data:', JSON.stringify(postData, null, 2));

        const response = await this.linkedInApi.create({
          resourcePath: '/v2/ugcPosts',
          entity: postData,
          accessToken: this.accessToken
        });
        
        console.log('✅ Successfully posted simple message to LinkedIn using UGC Posts API');
        console.log('Response:', response);
      }
    } catch (error) {
      console.error('❌ Error posting simple message to LinkedIn:', error);
      
      // Log more details about the error
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        console.error('Response status:', axiosError.response?.status);
        console.error('Response data:', axiosError.response?.data);
        console.error('Response headers:', axiosError.response?.headers);
      }
      
      throw error;
    }
  }

  // Helper to download image as Buffer
  async downloadImage(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  // Post with image to LinkedIn company page
  async postWithImage(message: string, imageUrl: string): Promise<any> {
    // 1. Register the image upload
    const registerRes = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        registerUploadRequest: {
          owner: `urn:li:organization:${this.orgId}`,
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          serviceRelationships: [
            {
              identifier: 'urn:li:userGeneratedContent',
              relationshipType: 'OWNER'
            }
          ],
          supportedUploadMechanism: ['SYNCHRONOUS_UPLOAD']
        }
      })
    });
    const registerData = await registerRes.json();
    if (!registerRes.ok) {
      throw new Error(`Failed to register image upload: ${JSON.stringify(registerData)}`);
    }
    const uploadUrl = registerData.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const asset = registerData.value.asset;

    // 2. Download the image and upload to LinkedIn
    const imageBuffer = await this.downloadImage(imageUrl);
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'image/png'
      },
      body: imageBuffer
    });
    if (!uploadRes.ok) {
      const uploadErr = await uploadRes.text();
      throw new Error(`Failed to upload image to LinkedIn: ${uploadErr}`);
    }

    // 3. Create the post referencing the asset URN
    const postBody = {
      author: `urn:li:organization:${this.orgId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: message },
          shareMediaCategory: 'IMAGE',
          media: [
            {
              status: 'READY',
              description: { text: 'Screenshot from Public Domain Library' },
              media: asset,
              title: { text: 'Screenshot' }
            }
          ]
        }
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
      }
    };

    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postBody)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Failed to post to LinkedIn: ${JSON.stringify(data)}`);
    }
    return data;
  }

  /**
   * ---------------------------------------------------------
   *  COMMENT ON A COMPANY POST AS ORG (with book link)
   * ---------------------------------------------------------
   */
  public async commentPost(bookLink: string, postId: string): Promise<void> {
    const orgUrn = `urn:li:organization:${this.orgId}`;
    // Add UTM parameters to the book link for tracking
    const utmLink = `${bookLink}?utm_source=linkedin.com&utm_medium=referral&utm_campaign=linkedin-scheduled-posts`;
    
    // Add a comment as the organization
    const commentBody = {
      actor: orgUrn,
      object: postId,
      message: {
        text: `Download the ebook for free: ${utmLink}`
      }
    };
    const commentRes = await fetch('https://api.linkedin.com/v2/socialActions/' + encodeURIComponent(postId) + '/comments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commentBody)
    });
    const commentData = await commentRes.json();
    if (!commentRes.ok) {
      console.error('Failed to comment on post:', commentData);
    } else {
      console.log('✅ Successfully commented on post:', commentData);
    }
  }
}