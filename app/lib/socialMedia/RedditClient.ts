import { VercelPoolClient } from "@vercel/postgres";
import { BaseSocialMediaClient, SocialMediaClient } from "./SocialMediaClient";
import snoowrap from 'snoowrap';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NextResponse } from "next/server";


export class RedditClient extends BaseSocialMediaClient implements SocialMediaClient {
    protected platform = '/r/FreeEBOOKS/';
    private redditApi: snoowrap;

    constructor(apiConfig: { clientId: string; clientSecret: string; username: string; password: string; userAgent: string }) {
        super();
        this.redditApi = new snoowrap({
            clientId: apiConfig.clientId,
            clientSecret: apiConfig.clientSecret,
            username: apiConfig.username,
            password: apiConfig.password,
            userAgent: apiConfig.userAgent,
        });
    }

    async schedulePost(client: VercelPoolClient): Promise<any[]> {
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

    async publishScheduledPosts(client: VercelPoolClient): Promise<void> {
        try {
            const scheduledPosts = await this.fetchScheduledPosts(client);
            if (!scheduledPosts.length) {
                console.error('Reddit: No posts scheduled for today.');
            } else {
                console.log(`Reddit: Found ${scheduledPosts.length} scheduled posts for today.`);
            }

            for (const post of scheduledPosts) {
                try {
                    const utmParams = 'utm_source=reddit.com&utm_medium=referral&utm_campaign=FreeEBOOKS';
                    const expandedLink = post.book_link.includes('?') 
                        ? `${post.book_link}&${utmParams}` 
                        : `${post.book_link}?${utmParams}`;

                    await this.submitLinkWithFlair(this.redditApi, 'FreeEBOOKS', post.text, expandedLink, 'a0931564-ffaf-11e2-9318-12313b0cf20e', '');
                    await this.updatePostStatus(client, post.id);
                    console.log(`Reddit Link \"${post.text}\" published successfully.`);
                } catch (error) {
                    if (error instanceof Error) {
                        console.error(`Failed to publish post ID ${post.text}:`, error.message);
                    } else {
                        console.error(`Unpextected error while publishing post ID ${post.text}:`, error);
                    }
                    throw error; // Re-throw the error after logging         
                }
            }

        } catch (error) {
            if (error instanceof Error) {
                console.error('   Reddit: Error processing scheduled posts:', error.message);
            } else {
                console.error('   Reddit: An unexpected error processing scheduled posts::', error);
            }
            throw error; // Re-throw the error after logging 
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
    async submitLinkWithFlair(redditClient, subreddit, title, url, flairId, flairText) {
        try {
            const subredditObj = redditClient.getSubreddit(subreddit);

            // Prepare the options for the submission
            const options: any = {
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

    // Only used for testing
    /**
   * Fetch the latest posts from a subreddit.
   * @param subreddit - The name of the subreddit (e.g., "javascript").
   * @param limit - The number of latest posts to fetch (default: 10).
   * @returns A promise that resolves to an array of posts.
   */
    async getLatestPosts(subreddit: string, limit: number = 10): Promise<snoowrap.Submission[]> {
        try {
            console.log(`Fetching latest ${limit} posts from subreddit: ${subreddit}`);

            // Get more posts initially since we'll filter by time
            const posts = await this.redditApi.getSubreddit(subreddit).getNew({ limit: limit * 5 });

            // Filter posts from the last 15 minutes
            const fifteenMinutesAgo = Math.floor(Date.now() / 1000) - (15 * 60);
            const recentPosts = posts.filter(post => post.created_utc >= fifteenMinutesAgo);

            // Return up to the requested limit
            const result = recentPosts.slice(0, limit);

            console.log(`Fetched ${result.length} posts from the last 15 minutes from subreddit: ${subreddit}`);
            return result;
        } catch (error) {
            console.error(`Failed to fetch posts from subreddit: ${subreddit}`, error);
            throw error;
        }
    }

    /**
     * Posts a reply to a Reddit post with the book suggestion and upvotes the post
     * @param dbclient - Database client
     * @param post - The Reddit post to reply to
     * @param replyMessage - The formatted reply message to post
     * @returns Promise that resolves when the reply is posted
     */
    async postBookSuggestion(
        post: snoowrap.Submission,
        replyMessage: string
    ): Promise<void> {
        try {
            await (post.reply(replyMessage) as unknown as Promise<void>);
            await (post.upvote() as unknown as Promise<void>);
            console.log(`Posted reply to post: ${post.id}\n`);
        } catch (error) {
            console.error(`Failed to post reply to ${post.id}:`, error);
            throw error;
        }
    }

    async quarterHourly(dbclient: VercelPoolClient): Promise<string> {
        const bookRequests = await this.getLatestBookRequests(dbclient, "suggestmeabook");
        const bookSuggestions = await this.suggestBooksForRequests(bookRequests);
        const bookSuggestion = await this.selectBookRequest(bookSuggestions);

        if (bookSuggestion.length > 0) {
            const post = bookSuggestion[0];
            const suggestion = bookSuggestions.find(s => s.post.id === post.id)?.suggestions;
            if (suggestion) {
                const replyMessage = await this.composeReply(suggestion, dbclient);
                if (replyMessage && replyMessage.trim() !== "") {
                    await this.postBookSuggestion(post, replyMessage);
                    return `Replied to book suggestion.`;
                }
            }
        }
        
        return `No suitable book suggestions found.`;
    }

    async suggestBooks(request: string): Promise<string>  {
        try {
          const client = new BedrockRuntimeClient({
            region: process.env.AWS_REGION,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
            },
          });
      
          const systemPrompt = 'You are PD-Book-Bot. Rules: Recommend ONLY titles that appear between <<BOOK_LIST_START>> and <<BOOK_LIST_END>> in the user prompt.; Rank them by overall_score (0-5) that YOU assign for fit to the OP request.; hook should be 100 characters or less;Return at most 3 books in valid JSON like: { "intro": "Here are some classic books you might enjoy based on your request.", "books": [ { "overall_score": 4.2, "title": "Dracula", "hook": "A solicitor visits a Transylvanian count with a dark secret." }] }; If none score ≥ 3.4, reply with [] (empty JSON array). No extra text.';
      
          const userPrompt = `<<BOOK_LIST_START>> Sense and Sensibility The Hound of the Baskervilles The Time Machine The Great Gatsby Pride & Prejudice Romeo and Juliet Little Women Jane Eyre Wuthering Heights Frankenstein The Picture of Dorian Gray The Adventures of Huckleberry Finn Dracula The Odyssey Anne of Green Gables A Tale of Two Cities The Count of Monte Cristo Crime and Punishment Emma Anna Karenina Les Misérables Alice's Adventures in Wonderland Moby-Dick The Art of War The Wonderful Wizard of Oz The Iliad The Adventures of Sherlock Holmes The Call of the Wild Peter Pan Meditations The Strange Case of Dr Jekyll and Mr Hyde Le Morte d\'Arthur The Autobiography of Benjamin Franklin Middlemarch A Room with a View The Blue Castle The Enchanted April Cranford History of Tom Jones, a Foundling Twenty years after A Doll\'s House A Christmas Carol The Scarlet Letter Gulliver's Travels The Importance of Being Earnest Great Expectations Women and Economics The Brothers Karamazov Don Quijote In Search of Lost Time Thus Spake Zarathustra Leviathan War and Peace Household Tales The Prince Heart of Darkness The Souls of Black Folk Winnie-the-Pooh Walden Dialogues Second Treatise of Government Beowulf: An Anglo-Saxon Epic Poem The Adventures of Tom Sawyer Tractatus Logico-Philosophicus Dubliners The divine comedy Bambi In a Glass Darkly Narrative of the Life of Frederick Douglass The Sketch-Book of Geoffrey Crayon, Gent. The War of the Worlds Fables Poetry Nicomachean Ethics The King in Yellow Candide The Interesting Narrative of the Life of Olaudah Equiano Incidents in the Life of a Slave Girl On Liberty Ethan Frome The Life and Adventures of Robinson Crusoe The History of the Peloponnesian War Paradise Lost The Wealth of Nations The Secret Garden The Origin of Species Madame Bovary The Turn of the Screw Philosophical Works The Awakening Flatland The House of Mirth The Last of the Mohicans The Story Of My Experiments With Truth The Communist Manifesto Noli Me Tangere <<BOOK_LIST_END>> ### OP_REQUEST ${request} ### END_OP_REQUEST`;
      
      
          const payload = {
            messages: [
              ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 500,
            temperature: 0.2,
          };
      
          //console.log('Payload:', JSON.stringify(request));
          const command = new InvokeModelCommand({
            modelId: 'mistral.mistral-large-2402-v1:0',
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
          });
      
          const response = await client.send(command);
          const responseBody = new TextDecoder().decode(response.body);
          const parsed = JSON.parse(responseBody);
          const content = parsed.choices[0]?.message.content || '';
      
           return content;
        } catch (error) {
          console.error('[Bedrock Mistral Error]', error);
          return "Failed to invoke Mistral";
        }
      }

    /**
     * Takes a JSON string with an intro and a books array, and returns a Reddit-markup reply string.
     * Uses the intro as the first line.
     * @param suggestionsJson - JSON string with { intro: string, books: Array }
     * @param dbclient - Database client for querying book and author info.
     * @returns A formatted string for Reddit comments.
     */
    async composeReply(
        suggestionsJson: string,
        dbclient: VercelPoolClient
    ): Promise<string> {
        try {
            const parsed = JSON.parse(suggestionsJson);
            const intro = typeof parsed.intro === "string" ? parsed.intro : "";
            const books = Array.isArray(parsed.books) ? parsed.books : [];

            if (books.length === 0) return "";

            const replyLines: string[] = [];
            const utmParams = 'utm_source=reddit.com&utm_medium=referral&utm_campaign=suggestmeabook';

            for (const s of books) {
                // Query the database for the book and link (no author)
                const { rows } = await dbclient.sql`
                    SELECT b.title, b.link
                    FROM books b
                    WHERE LOWER(b.title) = LOWER(${s.title})
                    LIMIT 1
                `;
                if (rows.length === 0) continue; // Skip if not found

                const { title, link } = rows[0];

                // Add UTM parameters to the link
                let linkWithUtm = link;
                if (linkWithUtm) {
                    linkWithUtm += (linkWithUtm.includes('?') ? '&' : '?') + utmParams;
                }

                replyLines.push(`* [${title}](${linkWithUtm}): ${s.hook}`);
            }

            if (replyLines.length > 0) {
                const publicDomainLibraryUrl = `https://publicdomainlibrary.org/en/?${utmParams}`;
                return [
                    intro,
                    "",
                    ...replyLines,
                    "",
                    `Click any title to download the free e-book from the [Public Domain Library](${publicDomainLibraryUrl}).`
                ].join('\n');
            } else {
                return "";
            }
        } catch (error) {
            console.error("Failed to compose reply:", error);
            return "";
        }
    }

    async getLatestBookRequests(
        dbclient: VercelPoolClient,
        subreddit: string = "suggestmeabook",
        limit: number = 10
    ): Promise<snoowrap.Submission[]> {
        // 1. Get last checked time from system_settings
        const { rows } = await dbclient.sql`
            SELECT value FROM system_settings WHERE key = 'last_checked_r_suggestmeabook'
        `;
        const lastChecked = rows[0]?.value ? Number(rows[0].value) : 0;

        // 2. Fetch new posts since lastChecked
        const posts = await this.redditApi.getSubreddit(subreddit).getNew({ limit: limit * 5 });
        const newPosts = posts.filter(post => post.created_utc > lastChecked).slice(0, limit);

        // 3. Update last checked time in system_settings
        const now = Math.floor(Date.now() / 1000);
        await dbclient.sql`
            INSERT INTO system_settings (key, value)
            VALUES ('last_checked_r_suggestmeabook', ${now})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `;

        return newPosts;
    }

    /**
     * Selects the book request with the highest overall score from the suggestions
     * @param suggestions - Array of objects containing posts and their suggestions
     * @returns Array containing the selected post with the highest score, or empty array if no post meets threshold
     */
    async selectBookRequest(
        suggestions: Array<{
            post: snoowrap.Submission;
            suggestions: string;
        }>
    ): Promise<snoowrap.Submission[]> {
        let highestScore = 0;
        let selectedPost: snoowrap.Submission | null = null;

        for (const { post, suggestions: suggestionStr } of suggestions) {
            try {
                const parsed = JSON.parse(suggestionStr);
                if (parsed.books && parsed.books.length > 0) {
                    // Get the highest score from the suggested books
                    const maxScore = Math.max(...parsed.books.map((book: any) => book.overall_score || 0));
                    
                    if (maxScore > highestScore) {
                        highestScore = maxScore;
                        selectedPost = post;
                    }
                }
            } catch (error) {
                console.error(`Error analyzing suggestions for post ${post.id}:`, error);
                continue;
            }
        }

        // If no post was selected (all had scores below threshold or errors), return empty array
        if (!selectedPost) {
            console.log('No posts met the score threshold');
            return [];
        }

        console.log(`Selected post ${selectedPost.id} with score ${highestScore}`);
        return [selectedPost];
    }

    /**
     * Processes multiple book requests and returns an array of suggestions
     * @param bookRequests - Array of Reddit posts containing book requests
     * @returns Array of objects containing the post and its book suggestions
     */
    async suggestBooksForRequests(bookRequests: snoowrap.Submission[]): Promise<Array<{
        post: snoowrap.Submission;
        suggestions: string;
    }>> {
        const suggestions: Array<{
            post: snoowrap.Submission;
            suggestions: string;
        }> = [];

        for (const post of bookRequests) {
            try {
                const combinedText = `${post.title}\n${post.selftext || ""}`;
                const suggestion = await this.suggestBooks(combinedText);
                
                // Only add if we got valid suggestions
                const parsed = JSON.parse(suggestion);
                if (parsed.books && parsed.books.length > 0) {
                    suggestions.push({
                        post,
                        suggestions: suggestion
                    });
                }
            } catch (error) {
                console.error(`Error getting suggestions for post ${post.id}:`, error);
                continue;
            }
        }

        console.log(`Suggestmeabook:Processed ${bookRequests.length} requests, found ${suggestions.length} valid suggestions`);
        return suggestions;
    }

}