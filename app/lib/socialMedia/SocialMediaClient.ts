import { VercelPoolClient } from "@vercel/postgres";

export interface SocialMediaClient {
  schedulePost(client: VercelPoolClient): Promise<any[]>;
  publishScheduledPosts(client: VercelPoolClient): Promise<void>;
}