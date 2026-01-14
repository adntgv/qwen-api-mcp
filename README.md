# Qwen API MCP Server

An MCP (Model Context Protocol) server for interacting with Qwen AI models. Supports text chat, video analysis, image analysis, and document processing.

## Features

- **Text Chat** - Conversations with Qwen language models
- **Video Analysis** - Analyze videos via URL or local file upload
- **Image Analysis** - Analyze images via URL, base64, or local file upload
- **Document Analysis** - Process PDFs, TXT, MD, DOC files
- **Web Search** - Enable real-time web search for up-to-date information
- **Thinking Mode** - Extended reasoning for complex problems

## Installation

```bash
npm install
npm run build
```

## Configuration

Set the `QWEN_API_TOKEN` environment variable:

```bash
export QWEN_API_TOKEN="your-api-token"
```

## Usage

### As MCP Server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "qwen": {
      "command": "node",
      "args": ["/path/to/qwen-api-mcp/dist/index.js"],
      "env": {
        "QWEN_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Tools

#### `qwen_chat`

Chat with Qwen models. Supports text, video URLs, image URLs, and documents.

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | string | The text message to send |
| `model` | string | Model to use (default: `qwen-max-latest`) |
| `video_url` | string | URL of a video to analyze |
| `image_url` | string | URL of an image or base64 data URL |
| `file_url` | string | URL of a document to analyze |
| `web_search` | boolean | Enable web search (default: false) |
| `enable_thinking` | boolean | Enable reasoning mode (default: false) |
| `thinking_budget` | number | Token budget for thinking (default: 30000) |
| `system_prompt` | string | Optional system prompt |

#### `qwen_upload_and_chat`

Upload a local video or image file and analyze it with Qwen.

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the local file |
| `message` | string | The question or prompt about the file |
| `model` | string | Model to use (default: `qwen-max-latest`) |
| `web_search` | boolean | Enable web search (default: false) |
| `enable_thinking` | boolean | Enable reasoning mode (default: false) |
| `thinking_budget` | number | Token budget for thinking (default: 30000) |

#### `qwen_list_models`

List all available Qwen models.

## Models

### Vision Models (for video/image)

- `qwen-max-latest` (recommended)
- `qwen3-vl-plus`
- `qwen3-vl-32b`
- `qvq-72b-preview-0310`
- `qwen-video`

### Text Models

- `qwen-max-latest`
- `qwen2.5-plus`
- `qwen2.5-turbo`

## Limitations

- Videos: Max 500MB, 10 minutes duration
- Cannot combine video and image in the same request
- Local file uploads use temporary hosting (60 min - 24h retention)

## License

MIT
