import * as dotenv from 'dotenv';
dotenv.config(); // Load environment variables from .env file

import axios from 'axios';
import OpenAI from 'openai';
// import * as fs from 'fs/promises'; // No longer saving image to disk
import * as path from 'path'; // For path manipulation, __dirname might still be useful
import { TwitterApi } from 'twitter-api-v2'; // Import Twitter API client
import { z } from 'zod';
import { zodTextFormat } from "openai/helpers/zod";

// --- Client Initialization ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const verificationResponseSchema = z.object({
  result: z.boolean().describe("Whether the image contains a Tunnl hat."),
  reasoning: z.string().describe("A short explanation of the reasoning for the result."),
});

if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set in the .env file.");
  process.exit(1);
}

if (!process.env.TWITTER_BEARER_TOKEN) {
  console.error("Error: TWITTER_BEARER_TOKEN is not set in the .env file. This is required to fetch tweet data.");
  process.exit(1);
}

const twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
const readOnlyTwitterClient = twitterClient.readOnly;

// --- Constants ----
// Set the ID of the tweet you want to process
const TWEET_ID: string = "1921316529062265045"; 
// const OUTPUT_IMAGE_PATH = path.join(__dirname, 'tweet_image.jpg'); // No longer saving image to disk

// --- Helper Functions ----

/**
 * Fetches tweet data by ID using the Twitter API v2 and extracts an image URL.
 */
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
async function askOpenAIAboutImage(imageUrl: string, question: string): Promise<string | null> {
  try {

    const response = await openai.responses.create({
      model: "gpt-4o",
      temperature: 0,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: question },
          ],
        },
      ],
      text: {
        format: zodTextFormat(verificationResponseSchema, 'response'),
      },
    });
    return response.choices[0]?.message?.content;
  } catch (error) {
    console.error("Error asking OpenAI:", error instanceof Error ? error.message : error);
    throw new Error(`Failed to get response from OpenAI about the image. ${error instanceof Error ? error.message : ''}`);
  }
}

const question = `Does this picture contain a black baseball hat with a "tunnl" logo on it?
I have provided you with 3 example images of the hat with the Tunnl logo on it named "tunnl-hat-front.jpg", "tunnl-hat-side-1.jpg", and "tunnl-hat-side-2.jpg".
The image you are analyzing is named "posted-image.jpg".
If you cannot see the hat with the logo anywhere in the image, respond with "no".
If you can see the hat with the logo anywhere in the image, respond with "yes".
`;

// --- Main Logic ----
async function main() {
  console.log(`Processing Tweet ID: ${TWEET_ID}`);

  try {
    const tweetData = await fetchTweetData(TWEET_ID);

    if (!tweetData.imageUrl) {
      // This error will be more specific if fetchTweetData logged a warning already
      throw new Error(`No image URL found for Tweet ID: ${TWEET_ID}.`);
    }

    const openAIResponse = await askOpenAIAboutImage(tweetData.imageUrl, question);

    if (openAIResponse) {
      console.log("OpenAI Response:", openAIResponse);
      
      const responseLower = openAIResponse.toLowerCase();
      // More robust keyword checking could be implemented
      const positiveKeywords = ["yes", "it does", "shows a black baseball hat"];
      const negativeKeywords = ["no", "it does not", "does not show"];
      
      let result: boolean | undefined;

      if (positiveKeywords.some(keyword => responseLower.includes(keyword))) {
        result = true;
      } else if (negativeKeywords.some(keyword => responseLower.includes(keyword))) {
        result = false;
      }

      if (result !== undefined) {
        console.log(`Does the image contain a black baseball hat with white lettering? ${result}`);
      } else {
        console.log("Could not definitively determine the answer from OpenAI's response.");
        console.log("Full OpenAI response:", openAIResponse);
        console.log(`Assuming 'false' due to ambiguous response for: Does the image contain a black baseball hat with white lettering?`);
      }

    } else {
      console.log("OpenAI did not provide a response.");
      console.log(`Result for "Does the image contain a black baseball hat with white lettering?": false (no OpenAI response)`);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
    console.error("Error in main execution:", errorMessage, error);
    // Final output indicating failure for the primary question
    console.log(`Result for "Does the image contain a black baseball hat with white lettering?": false (due to error: ${errorMessage})`);
  }
}

main().catch(error => {
  const errorMessage = error instanceof Error ? error.message : "An unknown unhandled error";
  console.error("Unhandled error in main execution:", errorMessage, error);
  process.exit(1);
}); 