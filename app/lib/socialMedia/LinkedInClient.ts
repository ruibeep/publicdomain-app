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
   *  SCHEDULE POST
   * ---------------------------------------------------------
   */
  public async schedulePost(client: VercelPoolClient): Promise<any[]> {
    console.log('LinkedIn schedulePost called - no specific implementation needed');
    return [];
  }

  /**
   * ---------------------------------------------------------
   *  PUBLISH SCHEDULED POSTS
   * ---------------------------------------------------------
   */
  public async publishScheduledPosts(client: VercelPoolClient): Promise<void> {
    try {
      console.log('Publishing scheduled LinkedIn posts...');
      const scheduledPosts = await this.fetchScheduledPosts(client);
      
      for (const post of scheduledPosts) {
        try {
          await this.postToLinkedIn(post.text, post.image_link);
          await this.updatePostStatus(client, post.id);
          console.log(`✅ Published LinkedIn post ID: ${post.id}`);
        } catch (error) {
          console.error(`❌ Failed to publish LinkedIn post ID ${post.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Error publishing scheduled LinkedIn posts:', error);
      throw error;
    }
  }

  /**
   * ---------------------------------------------------------
   *  POST TO LINKEDIN
   * ---------------------------------------------------------
   */
  public async postToLinkedIn(text: string, imageLink?: string | null): Promise<void> {
    try {
      console.log('Posting to LinkedIn:', text);
      
      // Create the post data according to LinkedIn UGC Posts API
      const postData = {
        author: `urn:li:person:${process.env.LINKEDIN_PERSON_ID}`,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text: text
            },
            shareMediaCategory: 'NONE'
          }
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
        }
      };

      // If there's an image, add it to the post
      if (imageLink) {
        // For LinkedIn, you typically need to upload the image first
        // This is a simplified version - you might need to implement image upload
        console.log('Image upload not implemented yet - posting text only');
      }

      // Make the API call to create the post
      const response = await this.linkedInApi.create({
        resourcePath: '/v2/ugcPosts',
        entity: postData,
        accessToken: this.accessToken
      });
      
      console.log('✅ Successfully posted to LinkedIn');
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
} 