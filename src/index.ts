import * as dotenv from 'dotenv';
dotenv.config();
import OpenAI from 'openai';
import { TwitterApi } from 'twitter-api-v2';
import { z } from 'zod';
import { zodResponseFormat } from "openai/helpers/zod";

const TWEET_ID: string = "1921299860000518230"; 

const referenceImageUrls = [
  "https://raw.githubusercontent.com/KuphJr/proof-of-hat/main/tunnl-hat-front.jpg",
  "https://raw.githubusercontent.com/KuphJr/proof-of-hat/main/tunnl-hat-side-1.jpg",
  "https://raw.githubusercontent.com/KuphJr/proof-of-hat/main/tunnl-hat-side-2.jpg",
];

if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set in the .env file.");
  process.exit(1);
}

if (!process.env.TWITTER_BEARER_TOKEN) {
  console.error("Error: TWITTER_BEARER_TOKEN is not set in the .env file. This is required to fetch tweet data.");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const verificationResponseSchema = z.object({
  result: z.boolean().describe("Whether the image contains a Tunnl hat."),
  reasoning: z.string().describe("A short explanation of the reasoning for the result."),
});

const twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
const readOnlyTwitterClient = twitterClient.readOnly;

async function fetchTweetData(tweetId: string): Promise<{ imageUrl?: string, text?: string }> {
  console.log(`Fetching tweet from Twitter API: ${tweetId}`);
  try {
    const tweet = await readOnlyTwitterClient.v2.singleTweet(tweetId, {
      expansions: ['attachments.media_keys'],
      'media.fields': ['url', 'type', 'preview_image_url'],
    });

    if (tweet.errors && tweet.errors.length > 0) {
      const errorDetail = tweet.errors[0].detail || tweet.errors[0].title;
      console.error('Error fetching tweet:', errorDetail, tweet.errors);
      throw new Error(`Failed to fetch tweet: ${errorDetail}`);
    }

    if (!tweet.data) {
      throw new Error('Tweet data not found in API response.');
    }

    const media = tweet.includes?.media;
    let imageUrl: string | undefined;

    if (media && media.length > 0) {
      // Prefer a direct photo URL
      const photoMedia = media.find(m => m.type === 'photo' && m.url);
      if (photoMedia?.url) {
        imageUrl = photoMedia.url;
      } else {
        // Fallback to preview_image_url for photos if direct url is not present
        const photoPreviewMedia = media.find(m => m.type === 'photo' && m.preview_image_url);
        if (photoPreviewMedia?.preview_image_url) {
          imageUrl = photoPreviewMedia.preview_image_url;
        } else {
          // Fallback to a video preview image if no photo is found
          const videoMediaWithPreview = media.find(m => m.type === 'video' && m.preview_image_url);
          if (videoMediaWithPreview?.preview_image_url) {
            imageUrl = videoMediaWithPreview.preview_image_url;
          }
        }
      }
    }

    if (!imageUrl) {
      console.warn(`Tweet ${tweetId} does not appear to contain a usable image URL (photo or video thumbnail).`);
    }

    return { imageUrl, text: tweet.data.text };

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Error fetching or processing tweet ${tweetId} from API:`, message, error);
    // Re-throw with a more specific message if needed, or handle differently
    throw new Error(`Failed to process tweet ${tweetId}: ${message}`);
  }
}

/**
 * Asks OpenAI a question about an image (provided as a Buffer).
 */
async function askOpenAIAboutImage(imageUrl: string) {

  const referenceImageMessages = referenceImageUrls.map(imageUrl => ({
    type: "image_url" as const,
    image_url: {
      url: imageUrl
    }
  }));

  const imageToAnalyzeMessage = {
    type: "image_url" as const,
    image_url: {
      url: imageUrl
    }
  };

  try {
    const result = await openai.beta.chat.completions.parse({
      model: "gpt-4o",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userPrompt
            },
            ...referenceImageMessages,
            imageToAnalyzeMessage
          ]
        },
      ],
      response_format: zodResponseFormat(verificationResponseSchema, 'response')
    });
    return result.choices[0]?.message?.parsed;
  } catch (error) {
    console.error("Error asking OpenAI:", error instanceof Error ? error.message : error);
    throw new Error(`Failed to get response from OpenAI about the image. ${error instanceof Error ? error.message : ''}`);
  }
}

const systemPrompt = `You are a vision model that analyzes images to determine if they contain a black baseball hat with a "tunnl" logo on it anywhere within the image.`;

const userPrompt = `The first 3 images are reference photos of the black baseball cap with the white "tunnl" logo. The last image is the image you are analyzing.
Please analyze the final image and return your answer in this exact JSON format:
{
  "result": true if the image contains a black baseball hat with a "tunnl" logo on it. false if you cannot see the hat with the logo anywhere in the image.
  "reasoning": "Short explanation of why or why not you think the image contains a black baseball hat with a "tunnl" logo on it."
}

Only output the JSON object.`

// --- Main Logic ----
async function main() {
  console.log(`Processing Tweet ID: ${TWEET_ID}`);

  try {
    const tweetData = await fetchTweetData(TWEET_ID);

    console.log(`Image URL: ${tweetData.imageUrl}`);

    if (!tweetData.imageUrl) {
      // This error will be more specific if fetchTweetData logged a warning already
      throw new Error(`No image URL found for Tweet ID: ${TWEET_ID}.`);
    }

    const openAIResponse = await askOpenAIAboutImage(tweetData.imageUrl);

    console.log(openAIResponse);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
    console.error("Error in main execution:", errorMessage, error);
    process.exit(1);
  }
}

main().catch(error => {
  const errorMessage = error instanceof Error ? error.message : "An unknown unhandled error";
  console.error("Unhandled error in main execution:", errorMessage, error);
  process.exit(1);
}); 