# LinkedIn Integration Setup

This document explains how to set up and use the LinkedIn integration to post messages.

## Prerequisites

1. A LinkedIn Developer Account
2. A LinkedIn App with appropriate permissions
3. Access token with posting permissions

## Environment Variables

Add the following environment variables to your `.env.local` file:

```bash
LINKEDIN_ACCESS_TOKEN=your_linkedin_access_token_here
LINKEDIN_PERSON_ID=your_linkedin_person_id_here
```

### Getting LinkedIn Access Token

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/)
2. Create a new app or use an existing one
3. Request the following permissions:
   - `w_member_social` (to post content)
4. Generate an access token with these permissions

### Getting LinkedIn Person ID

1. Go to your LinkedIn profile
2. The person ID is in the URL: `https://www.linkedin.com/in/your-profile/`
3. You can also get it via the LinkedIn API by calling the `/v2/me` endpoint

## Usage

### Test the Integration

To test posting "hello world!" to LinkedIn:

```bash
# GET request to see endpoint info
curl http://localhost:3000/test/linkedin

# POST request to send the message
curl -X POST http://localhost:3000/test/linkedin
```

### Using the LinkedIn Client in Code

```typescript
import { LinkedInClient } from './app/lib/socialMedia/LinkedInClient';

// Create client
const linkedInClient = new LinkedInClient(process.env.LINKEDIN_ACCESS_TOKEN!);

// Post a simple message
await linkedInClient.postSimpleMessage("Hello from my app!");

// Post with image (image upload not yet implemented)
await linkedInClient.postToLinkedIn("Hello with image!", "https://example.com/image.jpg");
```

## API Endpoints

- `GET /test/linkedin` - Get information about the LinkedIn test endpoint
- `POST /test/linkedin` - Post "hello world!" to LinkedIn

## Notes

- The LinkedIn API requires proper authentication and permissions
- Image upload functionality is not yet implemented
- Posts are set to public visibility by default
- The integration follows the same pattern as other social media clients in the app

## Troubleshooting

1. **Access Token Error**: Make sure your access token is valid and has the required permissions
2. **Person ID Error**: Verify your LinkedIn person ID is correct
3. **API Errors**: Check the LinkedIn API documentation for specific error codes
4. **Rate Limiting**: LinkedIn has rate limits, so don't post too frequently

## LinkedIn API Documentation

For more information about the LinkedIn API, visit:
- [LinkedIn API Documentation](https://developer.linkedin.com/docs)
- [UGC Posts API](https://developer.linkedin.com/docs/v2/ugc-posts) 