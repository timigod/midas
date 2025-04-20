import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { cron } from "https://deno.land/x/deno_cron/cron.ts";

// Add Deno namespace declaration for TypeScript
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

// Initialize Supabase client
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Supabase admin client for operations that require bypassing RLS
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

// Data365 Twitter API configuration
const DATA365_TWITTER_API_URL = Deno.env.get("DATA365_TWITTER_API_URL")!;
const DATA365_TWITTER_API_KEY = Deno.env.get("DATA365_TWITTER_API_KEY")!;

// Constants
const TRACTION_THRESHOLD = 100; // Threshold for positive social sentiment
const MOMENTUM_FACTOR = 0.3; // Momentum factor for composite score calculation
const POLL_INTERVAL_MS = 10000; // 10 seconds between polling attempts (increased from 5s)
const MAX_POLL_ATTEMPTS = 6; // Maximum number of polling attempts (1 minute total)

// Token interface
interface Token {
  id: number;
  token_mint: string;
  name: string;
  symbol: string;
  market_cap_usd: number;
  positive_social_sentiment: boolean;
  last_social_check: string | null;
}

// Twitter post interface
interface TwitterPost {
  favorite_count: number;
  retweet_count: number;
  // Other fields not used in our calculation
}

// Twitter search response interface
interface TwitterSearchResponse {
  data: {
    items: TwitterPost[];
    page_info?: {
      cursor?: string;
    };
    status?: string;
  };
  error: any;
  status: string;
}

// Traction data interface
interface TractionData {
  tweetCount: number;
  totalRetweets: number;
  totalLikes: number;
  tractionScore: number;
  compositeScore: number;
}

// Function to fetch tokens from token_hotness table
async function fetchHotTokens(): Promise<Token[]> {
  try {
    // April 6, 2025 in ISO format
    const april6_2025 = "2025-04-06T00:00:00.000Z";

    const { data, error } = await supabaseAdmin
      .from("token_hotness")
      .select(
        "id, token_mint, name, symbol, market_cap_usd, positive_social_sentiment, last_social_check, detected_at"
      )
      .gt("detected_at", april6_2025) // Only tokens detected after April 6, 2025
      .order("last_social_check", { ascending: true, nullsFirst: true });

    if (error) {
      console.error("Error fetching hot tokens:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Exception fetching hot tokens:", error);
    return [];
  }
}

// Function to create a Twitter search task
async function createTwitterSearchTask(token: Token): Promise<string | null> {
  try {
    // Calculate time window (30 minutes ago to now)
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Format dates as ISO 8601
    const fromDate = thirtyMinutesAgo.toISOString();
    const toDate = now.toISOString();

    // Construct search keywords using token name and symbol
    const keywords = `(${token.name} OR ${token.symbol})`;

    // Create search parameters
    const searchParams = new URLSearchParams({
      keywords: encodeURIComponent(keywords),
      from_date: fromDate,
      to_date: toDate,
      search_type: "latest",
      max_posts: "200",
      lang: "en", // Filter for English content to focus on relevant posts
      access_token: DATA365_TWITTER_API_KEY,
    });

    // Log the API request
    const apiUrl = `${DATA365_TWITTER_API_URL}/twitter/search/post/update?${searchParams.toString()}`;
    console.log(`Search Task Create, POST, ${apiUrl}`);

    // Make API request to create search task
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        `HTTP error ${response.status} creating search task for token ${token.name}`
      );
      return null;
    }

    const data = await response.json();
    console.log(`Search Task Create Response: ${JSON.stringify(data)}`);

    if (data.status === "accepted" && data.data?.task_id) {
      console.log(
        `Created search task for token ${token.name} with task_id: ${data.data.task_id}`
      );
      return data.data.task_id;
    } else {
      console.error(
        `Error creating Twitter search task for token ${token.name}:`,
        data.error || "Unknown error"
      );
      return null;
    }
  } catch (error) {
    console.error(
      `Exception creating Twitter search task for token ${token.name}:`,
      error
    );
    return null;
  }
}

// Function to poll for search task completion
async function pollSearchTaskStatus(
  token: Token,
  searchParams: URLSearchParams
): Promise<boolean> {
  console.log(`Polling search task status for token ${token.name}`);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    try {
      // searchParams already contains the access token
      const apiUrl = `${DATA365_TWITTER_API_URL}/twitter/search/post/update?${searchParams.toString()}`;
      console.log(
        `Search Task Status, GET, ${apiUrl} (attempt ${attempt + 1})`
      );

      // Make API request to check task status
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        console.error(`HTTP error ${response.status} for token ${token.name}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      const data = await response.json();
      console.log(
        `Search Task Status Response (attempt ${attempt + 1}): ${JSON.stringify(
          data
        )}`
      );

      if (data.status === "ok" && data.data?.status === "finished") {
        console.log(
          `Search task completed for token ${token.name} after ${
            attempt + 1
          } attempts`
        );
        return true;
      }

      console.log(
        `Polling attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS} for token ${
          token.name
        }: status=${data.data?.status || "unknown"}`
      );

      // Wait before next polling attempt
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      console.error(
        `Exception polling search task status for token ${
          token.name
        } (attempt ${attempt + 1}):`,
        error
      );
    }
  }

  console.error(`Max polling attempts reached for token ${token.name}`);
  return false;
}

// Function to fetch Twitter posts
async function fetchTwitterPosts(
  token: Token,
  searchParams: URLSearchParams
): Promise<TwitterPost[]> {
  const allPosts: TwitterPost[] = [];
  let cursor: string | null = null;

  try {
    do {
      // Add cursor to search parameters if available
      const params = new URLSearchParams(searchParams);
      if (cursor) {
        params.set("cursor", cursor);
      }
      params.set("max_page_size", "100");

      // Correct endpoint is /twitter/search/post/posts
      const apiUrl = `${DATA365_TWITTER_API_URL}/twitter/search/post/posts?${params.toString()}`;
      console.log(`Fetch Posts, GET, ${apiUrl}`);

      // Make API request to fetch posts
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        console.error(
          `HTTP error ${response.status} fetching posts for token ${token.name}`
        );
        break;
      }

      const postsData = await response.json();

      // Log a summary of the response (not the full items array which could be large)
      const responseLog = {
        status: postsData.status,
        error: postsData.error,
        itemCount: postsData.data?.items?.length || 0,
        hasCursor: !!postsData.data?.page_info?.cursor,
        hasNextPage: postsData.data?.page_info?.has_next_page,
      };
      console.log(`Fetch Posts Response: ${JSON.stringify(responseLog)}`);

      // Extract items from response, defaulting to empty array if not present
      const items = postsData.data?.items || [];
      allPosts.push(...items);

      // Get cursor for next page, or null if not present
      cursor = postsData.data?.page_info?.cursor || null;

      // Log any errors
      if (postsData.status !== "ok") {
        console.error("Error in Twitter posts response:", postsData.error);
        break;
      }
    } while (cursor && allPosts.length < 200); // Limit to 200 posts

    console.log(`Fetched ${allPosts.length} posts for token ${token.name}`);
    return allPosts;
  } catch (error) {
    console.error("Exception fetching Twitter posts:", error);
    return [];
  }
}

// Function to calculate traction score
function calculateTractionScore(posts: TwitterPost[]): TractionData {
  const tweetCount = posts.length;
  const totalRetweets = posts.reduce(
    (sum, post) => sum + (post.retweet_count || 0),
    0
  );
  const totalLikes = posts.reduce(
    (sum, post) => sum + (post.favorite_count || 0),
    0
  );

  // Calculate raw traction score
  // raw_score = tweetCount + 0.5 × totalRetweets + 0.2 × totalLikes
  const tractionScore = tweetCount + 0.5 * totalRetweets + 0.2 * totalLikes;

  return {
    tweetCount,
    totalRetweets,
    totalLikes,
    tractionScore,
    compositeScore: tractionScore, // Will be updated with momentum in the next step
  };
}

// Function to calculate composite score with momentum
async function calculateCompositeScore(
  tokenId: number,
  tractionData: TractionData
): Promise<number> {
  try {
    // Get previous traction score
    const { data, error } = await supabaseAdmin
      .from("token_social_traction")
      .select("traction_score")
      .eq("token_id", tokenId)
      .order("fetched_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error("Error fetching previous traction score:", error);
      return tractionData.tractionScore; // Return raw score if error
    }

    const previousTractionScore =
      data && data.length > 0 ? data[0].traction_score : 0;

    // Calculate delta
    const delta = tractionData.tractionScore - previousTractionScore;

    // Calculate composite score
    // composite_score = raw_score + MOMENTUM_FACTOR × delta
    const compositeScore = tractionData.tractionScore + MOMENTUM_FACTOR * delta;

    return compositeScore;
  } catch (error) {
    console.error("Exception calculating composite score:", error);
    return tractionData.tractionScore; // Return raw score if exception
  }
}

// Function to save traction data to database
async function saveTractionData(
  token: Token,
  tractionData: TractionData
): Promise<boolean> {
  try {
    // Insert into token_social_traction table
    const { error: insertError } = await supabaseAdmin
      .from("token_social_traction")
      .insert({
        token_id: token.id,
        token_mint: token.token_mint,
        tweet_count: tractionData.tweetCount,
        retweet_count: tractionData.totalRetweets,
        like_count: tractionData.totalLikes,
        traction_score: tractionData.tractionScore,
        composite_score: tractionData.compositeScore,
      });

    if (insertError) {
      console.error("Error inserting traction data:", insertError);
      return false;
    }

    // Update token_hotness table
    const positiveSocialSentiment =
      tractionData.compositeScore >= TRACTION_THRESHOLD;

    const { error: updateError } = await supabaseAdmin
      .from("token_hotness")
      .update({
        positive_social_sentiment: positiveSocialSentiment,
        last_social_check: new Date().toISOString(),
      })
      .eq("id", token.id);

    if (updateError) {
      console.error("Error updating token hotness:", updateError);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Exception saving traction data:", error);
    return false;
  }
}

// This function is no longer used directly - functionality moved to createSearchTaskForToken and processTokenWithTask
// Keeping for reference
async function processToken(token: Token): Promise<void> {
  try {
    console.log(`Processing token: ${token.name} (${token.symbol})`);

    // Calculate time window (30 minutes ago to now)
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Format dates as ISO 8601
    const fromDate = thirtyMinutesAgo.toISOString();
    const toDate = now.toISOString();

    // Construct search keywords using token name and symbol
    const keywords = `(${token.name} OR ${token.symbol})`;

    // Create search parameters with proper encoding
    const searchParams = new URLSearchParams({
      keywords: encodeURIComponent(keywords),
      from_date: fromDate,
      to_date: toDate,
      search_type: "latest",
      max_posts: "200",
      lang: "en", // Filter for English content
      access_token: DATA365_TWITTER_API_KEY,
    });

    // Create search task
    const taskId = await createTwitterSearchTask(token);

    if (!taskId) {
      console.error(`Failed to create search task for token ${token.name}`);
      return;
    }

    // Poll for task completion
    const taskCompleted = await pollSearchTaskStatus(token, searchParams);

    if (!taskCompleted) {
      console.error(`Search task did not complete for token ${token.name}`);
      return;
    }

    // Fetch Twitter posts
    const posts = await fetchTwitterPosts(token, searchParams);

    if (posts.length === 0) {
      console.log(
        `No posts found for token ${token.name} in the last 30 minutes`
      );

      // Still save a record with zero counts
      const emptyTractionData = {
        tweetCount: 0,
        totalRetweets: 0,
        totalLikes: 0,
        tractionScore: 0,
        compositeScore: 0,
      };

      console.log(`Saving empty traction data for token ${token.name}`);

      await saveTractionData(token, emptyTractionData);
      return;
    }

    // Calculate traction score
    const tractionData = calculateTractionScore(posts);

    // Calculate composite score with momentum
    tractionData.compositeScore = await calculateCompositeScore(
      token.id,
      tractionData
    );

    // Save traction data to database
    const saved = await saveTractionData(token, tractionData);

    if (saved) {
      console.log(
        `Successfully processed token ${
          token.name
        } with composite score ${tractionData.compositeScore.toFixed(2)}`
      );
    } else {
      console.error(`Failed to save traction data for token ${token.name}`);
    }
  } catch (error) {
    console.error(`Exception processing token ${token.name}:`, error);
    throw error; // Re-throw to be caught by the main function
  }
}

// Create search task and return task information
async function createSearchTaskForToken(token: Token): Promise<{
  token: Token;
  taskId: string | null;
  searchParams: URLSearchParams;
} | null> {
  try {
    // Calculate time window (30 minutes ago to now)
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Format dates as ISO 8601
    const fromDate = thirtyMinutesAgo.toISOString();
    const toDate = now.toISOString();

    // Construct search keywords using token name and symbol
    const keywords = `(${token.name} OR ${token.symbol})`;

    // Create search parameters with proper encoding
    const searchParams = new URLSearchParams({
      keywords: encodeURIComponent(keywords),
      from_date: fromDate,
      to_date: toDate,
      search_type: "latest",
      max_posts: "200",
      lang: "en", // Filter for English content
      access_token: DATA365_TWITTER_API_KEY,
    });

    // Create search task
    const taskId = await createTwitterSearchTask(token);

    if (!taskId) {
      console.error(`Failed to create search task for token ${token.name}`);
      return null;
    }

    return { token, taskId, searchParams };
  } catch (error) {
    console.error(`Error creating search task for token ${token.name}:`, error);
    return null;
  }
}

// Process token with existing task ID and search parameters
async function processTokenWithTask(
  token: Token,
  taskId: string,
  searchParams: URLSearchParams
): Promise<boolean> {
  try {
    // Poll for task completion
    const taskCompleted = await pollSearchTaskStatus(token, searchParams);

    if (!taskCompleted) {
      console.error(`Search task did not complete for token ${token.name}`);
      return false;
    }

    // Fetch Twitter posts
    const posts = await fetchTwitterPosts(token, searchParams);

    if (posts.length === 0) {
      console.log(
        `No posts found for token ${token.name} in the last 30 minutes`
      );

      // Still save a record with zero counts
      const emptyTractionData = {
        tweetCount: 0,
        totalRetweets: 0,
        totalLikes: 0,
        tractionScore: 0,
        compositeScore: 0,
      };

      console.log(`Saving empty traction data for token ${token.name}`);

      await saveTractionData(token, emptyTractionData);
      return true;
    }

    // Calculate traction score
    const tractionData = calculateTractionScore(posts);

    // Calculate composite score with momentum
    tractionData.compositeScore = await calculateCompositeScore(
      token.id,
      tractionData
    );

    // Save traction data to database
    const saved = await saveTractionData(token, tractionData);

    if (saved) {
      console.log(
        `Successfully processed token ${
          token.name
        } with composite score ${tractionData.compositeScore.toFixed(2)}`
      );
      return true;
    } else {
      console.error(`Failed to save traction data for token ${token.name}`);
      return false;
    }
  } catch (error) {
    console.error(`Exception processing token ${token.name}:`, error);
    return false;
  }
}

// Main function to fetch social traction
async function fetchSocialTraction(): Promise<void> {
  try {
    console.log("Starting fetchSocialTraction function");

    // Fetch hot tokens
    const tokens = await fetchHotTokens();
    console.log(`Fetched ${tokens.length} hot tokens`);

    if (tokens.length === 0) {
      console.log("No hot tokens found to process");
      return;
    }

    // Step 1: Create search tasks for all tokens
    console.log("Creating search tasks for all tokens...");
    const taskPromises = tokens.map((token) => createSearchTaskForToken(token));
    const taskResults = await Promise.all(taskPromises);

    // Filter out null results (failed task creations)
    const validTasks = taskResults.filter((result) => result !== null) as {
      token: Token;
      taskId: string;
      searchParams: URLSearchParams;
    }[];

    console.log(
      `Successfully created ${validTasks.length} search tasks out of ${tokens.length} tokens`
    );

    if (validTasks.length === 0) {
      console.log("No valid search tasks created, exiting");
      return;
    }

    // Step 2: Wait for 15 seconds before checking task status
    console.log("Waiting 15 seconds before checking task status...");
    await new Promise((resolve) => setTimeout(resolve, 15000));

    // Step 3: Check status and process completed tasks
    console.log("Checking task status and processing completed tasks...");
    let successCount = 0;
    let errorCount = 0;

    for (const task of validTasks) {
      try {
        const success = await processTokenWithTask(
          task.token,
          task.taskId,
          task.searchParams
        );
        if (success) {
          successCount++;
        } else {
          errorCount++;
        }
      } catch (error) {
        console.error(
          `Error processing task for token ${task.token.name}:`,
          error
        );
        errorCount++;
      }
    }

    console.log(
      `Completed fetchSocialTraction function. Successfully processed: ${successCount}, Errors: ${errorCount}`
    );
  } catch (error) {
    console.error("Exception in fetchSocialTraction:", error);
  }
}

// Schedule function to run every 30 minutes
cron("*/30 * * * *", fetchSocialTraction);

// Handle HTTP requests
Deno.serve(async (req) => {
  if (req.method === "POST") {
    // Manual trigger
    await fetchSocialTraction();
    return new Response(
      JSON.stringify({ message: "Social traction fetch triggered manually" }),
      { headers: { "Content-Type": "application/json" } }
    );
  } else {
    // Return information about the function
    return new Response(
      JSON.stringify({
        message: "Social traction fetch function",
        description:
          "This function runs every 30 minutes to fetch social traction data for hot tokens",
        schedule: "*/30 * * * *",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
});
