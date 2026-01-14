#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const QWEN_API_BASE = "https://qwen.aikit.club";

// Get token from environment
function getToken(): string {
  const token = process.env.QWEN_API_TOKEN;
  if (!token) {
    throw new Error("QWEN_API_TOKEN environment variable is required");
  }
  return token;
}

// API helper function
async function qwenFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getToken();
  const url = `${QWEN_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  return response;
}

// Upload to tmpfiles.org (60 min retention)
async function uploadToTmpfiles(filePath: string): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  // Create multipart form data manually
  const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const bodyParts = [Buffer.from(header), fileBuffer, Buffer.from(footer)];
  const body = Buffer.concat(bodyParts);

  const response = await fetch("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`tmpfiles.org upload failed: ${response.status}`);
  }

  const data = await response.json() as { status: string; data?: { url: string } };
  if (data.status !== "success" || !data.data?.url) {
    throw new Error("tmpfiles.org returned invalid response");
  }

  // tmpfiles.org returns URLs like https://tmpfiles.org/1234567/file.mp4
  // We need to convert to direct download: https://tmpfiles.org/dl/1234567/file.mp4
  const url = data.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
  return url;
}

// Upload to litterbox.catbox.moe (1-72h retention)
async function uploadToLitterbox(filePath: string, retention: string = "24h"): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  // Create multipart form data
  const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload`,
    `--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n${retention}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ];

  const header = Buffer.from(parts.join("\r\n") + "\r\n");
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileBuffer, footer]);

  const response = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Litterbox upload failed: ${response.status}`);
  }

  const url = await response.text();
  if (!url.startsWith("https://")) {
    throw new Error(`Litterbox returned invalid URL: ${url}`);
  }

  return url.trim();
}

// Upload file using fallback chain for China accessibility
async function uploadForQwenAccess(filePath: string): Promise<{ url: string; service: string }> {
  // Check file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const errors: string[] = [];

  // Try tmpfiles.org first (simple, 60 min retention)
  try {
    console.error("Trying tmpfiles.org...");
    const url = await uploadToTmpfiles(filePath);
    console.error("Uploaded to tmpfiles.org:", url);
    return { url, service: "tmpfiles.org" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("tmpfiles.org failed:", msg);
    errors.push(`tmpfiles.org: ${msg}`);
  }

  // Fallback to litterbox
  try {
    console.error("Trying litterbox.catbox.moe...");
    const url = await uploadToLitterbox(filePath);
    console.error("Uploaded to litterbox:", url);
    return { url, service: "litterbox.catbox.moe" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("litterbox failed:", msg);
    errors.push(`litterbox: ${msg}`);
  }

  throw new Error(
    `All upload services failed. Please provide a China-accessible URL directly using qwen_chat.\n\nErrors:\n${errors.join("\n")}`
  );
}

// Vision-capable models for video/image analysis
const VISION_MODELS = [
  "qwen-max-latest",
  "qwen3-vl-plus",
  "qwen3-vl-32b",
  "qwen3-vl-30b-a3b",
  "qwen2.5-vl-32b-instruct",
  "qvq-72b-preview-0310",
  "qwen-video",
];

// Cache available models to avoid repeated API calls
let cachedModels: string[] | null = null;

async function getAvailableModels(): Promise<string[]> {
  if (cachedModels) return cachedModels;
  try {
    const response = await qwenFetch("/v1/models", { method: "GET" });
    if (response.ok) {
      const data = await response.json();
      cachedModels = data.data?.map((m: { id: string }) => m.id) || [];
    }
  } catch {
    // If we can't fetch models, return empty array (validation will be skipped)
  }
  return cachedModels || [];
}

async function validateModel(
  model: string
): Promise<{ valid: boolean; suggestion?: string; availableVisionModels?: string[] }> {
  const models = await getAvailableModels();

  // If we couldn't fetch models, skip validation
  if (models.length === 0) return { valid: true };

  if (models.includes(model)) return { valid: true };

  // Find similar model names for suggestion
  const modelLower = model.toLowerCase().replace(/[-_]/g, "");
  const similar = models.find((m) => {
    const mLower = m.toLowerCase().replace(/[-_]/g, "");
    return mLower.includes(modelLower) || modelLower.includes(mLower.split("-")[0]);
  });

  // Get available vision models from the fetched list
  const availableVisionModels = models.filter((m) =>
    VISION_MODELS.some((vm) => m.toLowerCase().includes(vm.toLowerCase().split("-")[0]))
  );

  return {
    valid: false,
    suggestion: similar,
    availableVisionModels: availableVisionModels.length > 0 ? availableVisionModels : VISION_MODELS,
  };
}

function formatModelError(
  model: string,
  validation: { suggestion?: string; availableVisionModels?: string[] },
  isVideoRequest: boolean
): string {
  let msg = `Model "${model}" not found.`;

  if (validation.suggestion) {
    msg += `\nDid you mean "${validation.suggestion}"?`;
  }

  if (isVideoRequest && validation.availableVisionModels) {
    msg += `\n\nAvailable vision models for video/image analysis:\n`;
    msg += validation.availableVisionModels.map((m) => `- ${m}`).join("\n");
    msg += `\n\nRecommended: "qwen-max-latest" (works well with video)`;
  }

  return msg;
}

// Content part types for multimodal messages
type TextPart = { type: "text"; text: string };
type ImageUrlPart = { type: "image_url"; image_url: { url: string } };
type VideoUrlPart = { type: "video_url"; video_url: { url: string } };
type FileUrlPart = { type: "file_url"; file_url: { url: string } };
type ContentPart = TextPart | ImageUrlPart | VideoUrlPart | FileUrlPart;

interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
}

// Build message content with optional media attachments
function buildMessageContent(
  text: string,
  videoUrl?: string,
  imageUrl?: string,
  fileUrl?: string
): string | ContentPart[] {
  const parts: ContentPart[] = [];

  // Add video FIRST if provided (before text query)
  if (videoUrl) {
    parts.push({ type: "video_url", video_url: { url: videoUrl } });
  }

  // Add image FIRST if provided (before text query)
  if (imageUrl) {
    parts.push({ type: "image_url", image_url: { url: imageUrl } });
  }

  // Add file/document if provided
  if (fileUrl) {
    parts.push({ type: "file_url", file_url: { url: fileUrl } });
  }

  // Add text content AFTER media
  parts.push({ type: "text", text });

  // Return simple string if no media attachments
  if (parts.length === 1) {
    return text;
  }

  return parts;
}

// Create MCP server
const server = new McpServer({
  name: "qwen-api",
  version: "1.0.0",
});

// Tool: qwen_chat - Chat with Qwen models (supports video, images, documents)
server.tool(
  "qwen_chat",
  "Chat with Qwen AI models. Supports text, video URLs, image URLs, and document URLs. Use this to analyze videos, images, or have conversations.",
  {
    message: z.string().describe("The text message to send to Qwen"),
    model: z
      .string()
      .optional()
      .default("qwen-max-latest")
      .describe(
        "Model to use. For video/image: qwen-max-latest (recommended), qwen3-vl-plus, qvq-72b-preview-0310, qwen-video. For text: qwen-max-latest, qwen2.5-plus, qwen2.5-turbo"
      ),
    video_url: z
      .string()
      .optional()
      .describe(
        "URL of a video to analyze (MP4, MOV, AVI, MKV). Max 500MB, 10 min duration."
      ),
    image_url: z
      .string()
      .optional()
      .describe(
        "URL of an image to analyze (JPG, PNG, GIF, WebP) or base64 data URL"
      ),
    file_url: z
      .string()
      .optional()
      .describe("URL of a document to analyze (PDF, TXT, MD, DOC, etc.)"),
    web_search: z
      .boolean()
      .optional()
      .default(false)
      .describe("Enable web search for up-to-date information"),
    enable_thinking: z
      .boolean()
      .optional()
      .default(false)
      .describe("Enable thinking/reasoning mode for complex problems"),
    thinking_budget: z
      .number()
      .optional()
      .default(30000)
      .describe("Token budget for thinking mode (default: 30000)"),
    system_prompt: z
      .string()
      .optional()
      .describe("Optional system prompt to set context"),
  },
  async ({
    message,
    model,
    video_url,
    image_url,
    file_url,
    web_search,
    enable_thinking,
    thinking_budget,
    system_prompt,
  }) => {
    // Validate: cannot mix video with image (same media category)
    if (video_url && image_url) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: Cannot combine video and image in the same request. They are in the same media category. Use one or the other.",
          },
        ],
      };
    }

    // Validate model exists
    const isVideoOrImageRequest = !!(video_url || image_url);
    const validation = await validateModel(model);
    if (!validation.valid) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatModelError(model, validation, isVideoOrImageRequest),
          },
        ],
      };
    }

    // Build messages array
    const messages: Message[] = [];

    if (system_prompt) {
      messages.push({ role: "system", content: system_prompt });
    }

    messages.push({
      role: "user",
      content: buildMessageContent(message, video_url, image_url, file_url),
    });

    // Build request body
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    // Add web search tool if enabled
    if (web_search) {
      body.tools = [{ type: "web_search" }];
    }

    // Add thinking mode if enabled
    if (enable_thinking) {
      body.enable_thinking = true;
      body.thinking_budget = thinking_budget;
    }

    try {
      const response = await qwenFetch("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `API Error (${response.status}): ${errorText}`,
            },
          ],
        };
      }

      const data = await response.json();
      const assistantMessage =
        data.choices?.[0]?.message?.content || "No response received";

      return {
        content: [
          {
            type: "text" as const,
            text: assistantMessage,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text" as const,
            text: `Request failed: ${errorMessage}`,
          },
        ],
      };
    }
  }
);

// Tool: qwen_list_models - List available Qwen models
server.tool(
  "qwen_list_models",
  "List all available Qwen models and their capabilities",
  {},
  async () => {
    try {
      const response = await qwenFetch("/v1/models", {
        method: "GET",
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `API Error (${response.status}): ${errorText}`,
            },
          ],
        };
      }

      const data = await response.json();
      const models = data.data || [];

      // Format model list
      const modelList = models
        .map((m: { id: string }) => `- ${m.id}`)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Available Qwen Models:\n${modelList}\n\nFor video/image analysis, use vision models:\n- qwen-max-latest (recommended)\n- qwen3-vl-plus\n- qwen3-vl-32b\n- qvq-72b-preview-0310\n- qwen-video`,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text" as const,
            text: `Request failed: ${errorMessage}`,
          },
        ],
      };
    }
  }
);

// Tool: qwen_upload_and_chat - Upload local video/image and chat about it
server.tool(
  "qwen_upload_and_chat",
  "Upload a local video or image file to temporary hosting, then analyze it with Qwen. Use this when you have a local file path instead of a URL.",
  {
    file_path: z
      .string()
      .describe("Absolute path to the local video or image file to upload and analyze"),
    message: z.string().describe("The question or prompt about the file"),
    model: z
      .string()
      .optional()
      .default("qwen-max-latest")
      .describe("Model to use (default: qwen-max-latest). Vision models: qwen3-vl-plus, qvq-72b-preview-0310, qwen-video"),
    web_search: z
      .boolean()
      .optional()
      .default(false)
      .describe("Enable web search for additional context"),
    enable_thinking: z
      .boolean()
      .optional()
      .default(false)
      .describe("Enable thinking/reasoning mode"),
    thinking_budget: z
      .number()
      .optional()
      .default(30000)
      .describe("Token budget for thinking mode"),
  },
  async ({
    file_path,
    message,
    model,
    web_search,
    enable_thinking,
    thinking_budget,
  }) => {
    try {
      // Determine file type from extension
      const ext = path.extname(file_path).toLowerCase();
      const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv"];
      const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"];

      const isVideo = videoExts.includes(ext);
      const isImage = imageExts.includes(ext);

      if (!isVideo && !isImage) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unsupported file type: ${ext}. Supported video formats: ${videoExts.join(", ")}. Supported image formats: ${imageExts.join(", ")}.`,
            },
          ],
        };
      }

      // Check file size (500MB limit for Qwen video API)
      const stats = fs.statSync(file_path);
      const fileSizeMB = stats.size / (1024 * 1024);
      if (isVideo && fileSizeMB > 500) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Video too large: ${fileSizeMB.toFixed(2)}MB. Maximum allowed for videos is 500MB.`,
            },
          ],
        };
      }

      // Validate model exists (always vision request since we're uploading media)
      const validation = await validateModel(model);
      if (!validation.valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatModelError(model, validation, true),
            },
          ],
        };
      }

      // Upload file to temporary hosting service
      const { url: uploadedUrl, service } = await uploadForQwenAccess(file_path);

      // Build messages array
      const messages: Message[] = [];

      // Build content based on file type
      let content: string | ContentPart[];
      if (isVideo) {
        content = buildMessageContent(message, uploadedUrl, undefined, undefined);
      } else {
        content = buildMessageContent(message, undefined, uploadedUrl, undefined);
      }

      messages.push({ role: "user", content });

      // Build request body
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: false,
      };

      if (web_search) {
        body.tools = [{ type: "web_search" }];
      }

      if (enable_thinking) {
        body.enable_thinking = true;
        body.thinking_budget = thinking_budget;
      }

      const response = await qwenFetch("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `API Error (${response.status}): ${errorText}\n\nUploaded URL: ${uploadedUrl} (${service})`,
            },
          ],
        };
      }

      const data = await response.json();
      const assistantMessage =
        data.choices?.[0]?.message?.content || "No response received";

      return {
        content: [
          {
            type: "text" as const,
            text: `${assistantMessage}\n\n---\n*File uploaded via ${service}*`,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed: ${errorMessage}`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Qwen API MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
