# WaterBot - RAG-Powered Chatbot for Arizona Water Information

WaterBot is a Retrieval-Augmented Generation (RAG) chatbot that provides information about water in Arizona. It uses FastAPI, ChromaDB for vector storage, and supports both OpenAI and Claude (AWS Bedrock) LLM adapters.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [RAG Pipeline Flow](#rag-pipeline-flow)
- [Request/Response Flow](#requestresponse-flow)
- [Component Interactions](#component-interactions)
- [Data Flow](#data-flow)
- [Getting Started](#getting-started)
- [API Endpoints](#api-endpoints)
- [Configuration](#configuration)

## Overview

WaterBot is a conversational AI application that:
- Answers questions about water in Arizona using RAG (Retrieval-Augmented Generation)
- Supports both English and Spanish languages
- Maintains conversation history per session
- Provides source citations for answers
- Supports voice transcription via Amazon Transcribe
- Stores conversations in PostgreSQL and DynamoDB

## Architecture

### System Architecture Diagram

```mermaid
graph TB
    subgraph "Client Layer"
        A[Web Browser] --> B[FastAPI Application]
        A --> C[WebSocket Connection]
    end
    
    subgraph "Application Layer"
        B --> D[Session Middleware]
        D --> E[Memory Manager]
        D --> F[Chat API Endpoints]
        C --> G[Transcribe Handler]
        G --> F
    end
    
    subgraph "RAG Pipeline"
        F --> H[Language Detection]
        H --> I{Language?}
        I -->|English| J[ChromaManager<br/>English]
        I -->|Spanish| K[ChromaManager<br/>Spanish]
        J --> L[Vector Search]
        K --> L
        L --> M[Document Retrieval]
    end
    
    subgraph "LLM Layer"
        M --> N[LLM Adapter]
        N --> O{Adapter Type}
        O -->|OpenAI| P[OpenAI API]
        O -->|Claude| Q[AWS Bedrock]
    end
    
    subgraph "Storage Layer"
        E --> R[In-Memory<br/>Sessions]
        F --> S[PostgreSQL<br/>Messages]
        F --> T[DynamoDB<br/>Ratings]
        F --> U[S3<br/>Transcripts]
        J --> V[ChromaDB<br/>English]
        K --> W[ChromaDB<br/>Spanish]
    end
    
    style F fill:#e1f5ff
    style L fill:#fff4e1
    style N fill:#e8f5e9
    style V fill:#f3e5f5
    style W fill:#f3e5f5
```

## RAG Pipeline Flow

### RAG Pipeline Detailed Flow

```mermaid
flowchart TD
    Start([User Query]) --> SafetyCheck[Safety Checks<br/>Moderation & Intent]
    SafetyCheck -->|Fail| Reject[Reject Response]
    SafetyCheck -->|Pass| AddToMemory[Add User Message<br/>to Session Memory]
    AddToMemory --> DetectLang[Detect Language<br/>langdetect]
    DetectLang -->|English| EngKB[English Knowledge Base<br/>ChromaDB]
    DetectLang -->|Spanish| SpanKB[Spanish Knowledge Base<br/>ChromaDB]
    
    EngKB --> EmbedQuery[Embed User Query<br/>OpenAI Embeddings]
    SpanKB --> EmbedQuery
    
    EmbedQuery --> VectorSearch[Vector Similarity Search<br/>ChromaDB]
    VectorSearch --> RetrieveDocs[Retrieve Top K Documents<br/>k=4]
    RetrieveDocs --> ParseSources[Parse Source Metadata<br/>Extract URLs & Descriptions]
    ParseSources --> FormatKB[Format Knowledge Base<br/>Concatenate Document Content]
    
    FormatKB --> BuildPrompt[Build LLM Prompt<br/>System Prompt + KB + Chat History]
    BuildPrompt --> LLMCall[Call LLM<br/>OpenAI/Claude]
    LLMCall --> GenerateResponse[Generate Response]
    
    GenerateResponse --> StoreResponse[Store Response<br/>Memory + Database]
    StoreResponse --> ReturnResponse[Return Response<br/>with Sources]
    
    ReturnResponse --> End([End])
    Reject --> End
    
    style SafetyCheck fill:#ffebee
    style VectorSearch fill:#fff4e1
    style LLMCall fill:#e8f5e9
    style StoreResponse fill:#e1f5ff
```

## Request/Response Flow

### Chat API Request Flow

```mermaid
sequenceDiagram
    participant User
    participant FastAPI
    participant MemoryManager
    participant ChromaManager
    participant LLMAdapter
    participant PostgreSQL
    
    User->>FastAPI: POST /chat_api<br/>(user_query)
    FastAPI->>FastAPI: Extract Session UUID<br/>(Cookie/State)
    FastAPI->>MemoryManager: create_session(session_uuid)
    FastAPI->>LLMAdapter: safety_checks(user_query)
    LLMAdapter-->>FastAPI: moderation_result, intent_result
    
    alt Safety Check Failed
        FastAPI->>User: Reject Response
    else Safety Check Passed
        FastAPI->>MemoryManager: add_message_to_session<br/>(user_query)
        FastAPI->>FastAPI: detect_language(user_query)
        
        alt English
            FastAPI->>ChromaManager: ann_search(user_query)<br/>(English KB)
        else Spanish
            FastAPI->>ChromaManager: ann_search(user_query)<br/>(Spanish KB)
        end
        
        ChromaManager->>ChromaManager: similarity_search(user_query, k=4)
        ChromaManager->>ChromaManager: parse_source(metadata)
        ChromaManager-->>FastAPI: {documents, sources}
        
        FastAPI->>ChromaManager: knowledge_to_string(docs)
        ChromaManager-->>FastAPI: formatted_kb_string
        
        FastAPI->>MemoryManager: get_session_history_all()
        MemoryManager-->>FastAPI: chat_history
        
        FastAPI->>LLMAdapter: get_llm_body(kb_data, chat_history)
        LLMAdapter->>LLMAdapter: build_prompt(system + kb + history)
        LLMAdapter-->>FastAPI: llm_payload
        
        FastAPI->>LLMAdapter: generate_response(llm_payload)
        LLMAdapter->>LLMAdapter: Call OpenAI/Bedrock API
        LLMAdapter-->>FastAPI: response_content
        
        FastAPI->>MemoryManager: add_message_to_session<br/>(response + sources)
        FastAPI->>MemoryManager: increment_message_count()
        FastAPI->>PostgreSQL: log_message()<br/>(Background Task)
        FastAPI->>User: Return Response + Sources
    end
```

## Component Interactions

### Component Interaction Diagram

```mermaid
graph LR
    subgraph "Core Components"
        A[FastAPI App] --> B[MemoryManager]
        A --> C[ChromaManager]
        A --> D[LLMAdapter]
        A --> E[DynamoDBManager]
        A --> F[S3Manager]
    end
    
    subgraph "MemoryManager"
        B --> B1[Session Storage]
        B --> B2[Message Counts]
        B --> B3[Chat History]
    end
    
    subgraph "ChromaManager"
        C --> C1[Vector Search]
        C --> C2[Source Parsing]
        C --> C3[Knowledge Formatting]
        C1 --> C4[ChromaDB<br/>English Collection]
        C1 --> C5[ChromaDB<br/>Spanish Collection]
    end
    
    subgraph "LLMAdapter"
        D --> D1[OpenAIAdapter]
        D --> D2[BedrockClaudeAdapter]
        D1 --> D3[OpenAI API]
        D2 --> D4[AWS Bedrock]
    end
    
    subgraph "Storage"
        E --> E1[DynamoDB<br/>Ratings]
        F --> F1[S3<br/>Transcripts]
        A --> G[PostgreSQL<br/>Messages]
    end
    
    style A fill:#e1f5ff
    style C fill:#fff4e1
    style D fill:#e8f5e9
    style B fill:#f3e5f5
```

## Data Flow

### Data Flow Through the System

```mermaid
flowchart LR
    subgraph "Input"
        A[User Query<br/>Text/Voice]
        B[Session UUID<br/>Cookie]
    end
    
    subgraph "Processing"
        C[Language Detection]
        D[Vector Embedding]
        E[Similarity Search]
        F[Document Retrieval]
        G[LLM Generation]
    end
    
    subgraph "Storage"
        H[ChromaDB<br/>Vector Store]
        I[MemoryManager<br/>Session State]
        J[PostgreSQL<br/>Message Log]
        K[DynamoDB<br/>Ratings]
        L[S3<br/>Transcripts]
    end
    
    subgraph "Output"
        M[Response Text]
        N[Source Citations]
        O[Message ID]
    end
    
    A --> C
    B --> I
    C --> D
    D --> E
    E --> H
    H --> F
    F --> G
    G --> M
    F --> N
    G --> I
    I --> J
    I --> K
    A --> L
    I --> O
    
    style H fill:#f3e5f5
    style G fill:#e8f5e9
    style I fill:#e1f5ff
```

## Getting Started

### Prerequisites

```bash
# Install system dependencies
sudo apt-get install jq

# Python 3.11+
python3.11 -m venv .venv
source .venv/bin/activate
```

### Environment Variables

Create a `.env` file in the `application/` directory:

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key

# AWS Configuration
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_SESSION_TOKEN=your_session_token  # Optional

# Database Configuration
DB_HOST=your_db_host
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name

# AWS Services
MESSAGES_TABLE=your_dynamodb_table
TRANSCRIPT_BUCKET_NAME=your_s3_bucket
```

### Installation

```bash
cd application
pip install -r requirements.txt
```

### Running Locally

```bash
# Activate virtual environment
source .venv/bin/activate

# Run FastAPI application
fastapi dev main.py
# or
uvicorn main:app --reload
```

### Running in Docker

```bash
./docker_build.sh
./docker_run.sh
```

## API Endpoints

### Chat Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/chat_api` | POST | Main chat endpoint for WaterBot |
| `/riverbot_chat_api` | POST | Chat endpoint for RiverBot persona |
| `/chat_sources_api` | POST | Get sources for previous response |
| `/chat_actionItems_api` | POST | Get action items from previous response |
| `/chat_detailed_api` | POST | Get detailed response for previous query |

### Other Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/waterbot` | GET | WaterBot HTML interface |
| `/riverbot` | GET | RiverBot HTML interface |
| `/transcribe` | WebSocket | Voice transcription endpoint |
| `/session-transcript` | POST | Download session transcript |
| `/submit_rating_api` | POST | Submit rating for a message |

## Configuration

### LLM Adapter Selection

In `main.py`, configure the adapter:

```python
# Available adapters
ADAPTERS = {
    "claude.haiku": BedrockClaudeAdapter("anthropic.claude-3-haiku-20240307-v1:0"),
    "claude.": BedrockClaudeAdapter("anthropic.claude-3-sonnet-20240229-v1:0"),
    "openai-gpt4.1": OpenAIAdapter("gpt-4.1")
}

# Set adapter
llm_adapter = ADAPTERS["openai-gpt4.1"]  # or "claude.haiku"
```

### ChromaDB Configuration

The ChromaDB collection name defaults to `"langchain"`. To use a different collection:

```python
knowledge_base = ChromaManager(
    persist_directory="docs/chroma/",
    embedding_function=embeddings,
    collection_name="your_collection_name"
)
```

### RAG Parameters

- **Top K Documents**: Default is 4 (configurable in `ann_search` method)
- **Chunk Size**: 1500 characters with 150 overlap (when adding documents)
- **Embedding Model**: OpenAI `text-embedding-ada-002` (via OpenAIEmbeddings)

## RAG Pipeline Components

### 1. ChromaManager
- **Purpose**: Manages vector database operations
- **Key Methods**:
  - `ann_search()`: Performs vector similarity search
  - `knowledge_to_string()`: Formats retrieved documents for LLM
  - `parse_source()`: Extracts and formats source metadata

### 2. MemoryManager
- **Purpose**: Manages conversation sessions and history
- **Key Methods**:
  - `create_session()`: Creates new conversation session
  - `add_message_to_session()`: Stores messages with sources
  - `get_session_history_all()`: Retrieves full conversation history

### 3. LLM Adapters
- **OpenAIAdapter**: Uses OpenAI GPT models
- **BedrockClaudeAdapter**: Uses AWS Bedrock Claude models
- Both implement:
  - `get_llm_body()`: Builds prompt with knowledge base
  - `generate_response()`: Calls LLM API
  - `safety_checks()`: Validates user input

## Troubleshooting

### RAG Pipeline Not Working

1. **Check ChromaDB Collection**: Ensure the collection name matches what was used when documents were added
   ```python
   # Verify collection exists
   knowledge_base = ChromaManager(
       persist_directory="docs/chroma/",
       embedding_function=embeddings,
       collection_name="langchain"  # Must match collection used when adding docs
   )
   ```

2. **Check Embeddings**: Verify embeddings are being generated
   ```python
   # Test embeddings
   embeddings = llm_adapter.get_embeddings()
   test_embedding = embeddings.embed_query("test")
   ```

3. **Check Documents**: Verify documents exist in ChromaDB
   ```python
   # Check if collection has documents
   docs = await knowledge_base.ann_search("test query")
   print(f"Retrieved {len(docs['documents'])} documents")
   ```

### Common Issues

- **"Collection langchain is not created"**: Ensure `collection_name="langchain"` is set in ChromaManager
- **Empty search results**: Verify documents were added to ChromaDB with the correct collection name
- **Embedding rate limits**: Check OpenAI API rate limits if using OpenAI embeddings

## Project Structure

```
waterbot/
├── application/
│   ├── main.py                 # FastAPI application
│   ├── managers/
│   │   ├── chroma_manager.py   # Vector database manager
│   │   ├── memory_manager.py   # Session management
│   │   ├── dynamodb_manager.py # DynamoDB operations
│   │   └── s3_manager.py       # S3 operations
│   ├── adapters/
│   │   ├── openai.py           # OpenAI adapter
│   │   ├── claude.py           # Claude/Bedrock adapter
│   │   └── base.py             # Base adapter interface
│   ├── docs/
│   │   └── chroma/             # ChromaDB storage
│   └── templates/              # HTML templates
├── docker_build.sh
├── docker_run.sh
└── README.md
```

## License

See LICENSE file for details.

## Additional Information

For deployment instructions, see the original README sections on:
- Running locally (container/no container)
- Deploying to AWS
- CDK prerequisites
- Environment-specific deployments

---

## Deployment: Quick Start (AWS)

The fastest path to deploy:

1) Set environment variables

```bash
export OPENAI_API_KEY="sk-..."
export SECRET_HEADER_KEY="your-secret-header"
export BASIC_AUTH_SECRET=$(echo -n "username:password" | base64)
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-west-2"
```

2) Deploy infrastructure (first time)

```bash
./scripts/setup_aws_infrastructure.sh dev
```

3) Deploy application

```bash
./scripts/deploy_to_aws.sh dev latest
```

CI/CD via GitHub Actions:
- Push to `feature-test` ➜ deploys to test
- Push to `main` ➜ deploys to dev

---

## AWS Deployment Guide (Consolidated)

Prerequisites:
- AWS CLI, Docker, Node.js + npm, Python 3.11+

Required environment:

```bash
export OPENAI_API_KEY="your-openai-api-key"
export SECRET_HEADER_KEY="your-secret-header-value"
export BASIC_AUTH_SECRET="base64-encoded-username:password"
export AWS_ACCESS_KEY_ID="your-aws-access-key"
export AWS_SECRET_ACCESS_KEY="your-aws-secret-key"
export AWS_REGION="us-west-2"
```

Infrastructure setup (CDK):

```bash
chmod +x scripts/setup_aws_infrastructure.sh
./scripts/setup_aws_infrastructure.sh dev
```

Manual deployment:

```bash
chmod +x scripts/deploy_to_aws.sh
./scripts/deploy_to_aws.sh dev latest
```

Monitoring:

```bash
aws logs tail /ecs/waterbot-dev --follow --region us-west-2
```

Troubleshooting highlights:
- Ensure `application/newData/` has PDFs if building ChromaDB in Docker
- Verify GitHub secrets set (see below)
- Check ECS events and CloudWatch logs on failures

---

## Test Environment (feature-test branch)

- `feature-test` ➜ automatically deploys to a dedicated test environment via GitHub Actions

First‑time setup:

```bash
export OPENAI_API_KEY="your-openai-api-key"
export SECRET_HEADER_KEY="your-secret-header"
export BASIC_AUTH_SECRET=$(echo -n "username:password" | base64)
./scripts/setup_aws_infrastructure.sh test
```

Manual deploy to test:

```bash
./scripts/deploy_to_aws.sh test latest
```

Check CloudFront URL from the `cdk-app-stack-test` stack outputs.

---

## Render Deployment (Backend)

Option 1: Deploy image from Docker Hub. Ensure environment variables:
- OPENAI_API_KEY
- MESSAGES_TABLE
- TRANSCRIPT_BUCKET_NAME
- DB_HOST / DB_USER / DB_PASSWORD / DB_NAME (if used)

Health check path: `/`

Option 2: Use `render.yaml` (Blueprint) to build from GitHub.

---

## Frontend on Vercel (Optional)

Set Vercel env var:
- `VITE_API_BASE_URL` = your backend URL

Backend must allow CORS for your Vercel domain.

Optional rewrites in `vercel.json` if proxying (`/api/*` → backend).

---

## GitHub Actions Secrets (How to set)

Add repository secrets:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `OPENAI_API_KEY`

GitHub → Settings → Secrets and variables → Actions → New repository secret.

More secure alternative: use OIDC with an IAM role (no long‑lived keys).

---

## Frontend Dev: CSS Cache Troubleshooting

If CSS changes are not reflecting:
1. Remove Vite cache: `rm -rf frontend/node_modules/.vite`
2. Restart dev server: `npm run dev`
3. Clear browser cache / use DevTools “Disable cache”
4. Ensure you’re on `http://localhost:5173` (Vite dev server)
5. Force reload with `?v=123`
