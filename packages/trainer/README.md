# 🧬 Jellyfish Trainer — QLoRA Fine-Tuning Guide

This module handles the **data distillation → QLoRA fine-tuning → inference hook-up** pipeline.

---

## Architecture Overview

```
Dashboard → /api/dataset/generate → dataset.ts
    ↓
teacher model (Gemini Pro) synthesizes ReAct trajectories
    ↓
download .jsonl dataset
    ↓
GPU server: python train.py → LoRA adapter
    ↓
serve with vLLM/Ollama (OpenAI-compatible API)
    ↓
wrangler.toml: set CUSTOM_LLM_URL + CUSTOM_LLM_KEY
    ↓
jellyfish worker routes all LLM calls to your fine-tuned model
```

---

## Step 1 — Generate Training Data

1. Deploy or run Jellyfish locally.
2. Open the Dashboard for your Agent.
3. Scroll to **"数据蒸馏与微调准备"** section.
4. Click **"生成并下载 JSONL 数据集"**.
5. Save the downloaded `.jsonl` file into this directory.

The API endpoint (`POST /api/dataset/generate`) calls the teacher model (your configured Gemini/Grok) and generates ~5 multi-turn Agent trajectories in ReAct format per call. Run it multiple times and concatenate files to build a larger training set.

### ReAct Format

Each JSONL line has a `"text"` field containing:

```
System: <skill document>
User: <trigger message>
Agent:
Thought: <internal reasoning>
Action: <optional — e.g., search_memory()>
Observation: <result of action or empty>
Response: <the actual tweet / reply>
```

---

## Step 2 — Train with QLoRA (Unsloth)

### Requirements

Run on a machine with an NVIDIA GPU with ≥16 GB VRAM. Tested on:
- NVIDIA A10G (24 GB) — AWS `g5.xlarge`
- NVIDIA A100 (40 GB) — RunPod
- NVIDIA RTX 4090 (24 GB) — local

```bash
pip install -r requirements.txt
```

> **Tip:** Use `unsloth/Llama-3-8b-Instruct-bnb-4bit` or `unsloth/Qwen2-7B-Instruct-bnb-4bit`
> as the base. Both are pre-quantised to 4-bit and load instantly.

### Run Training

```bash
python train.py \
  --dataset_path dataset_react_finetune_<agentId>.jsonl \
  --model_name unsloth/Llama-3-8b-Instruct-bnb-4bit \
  --output_dir outputs/jellyfish-agent-lora \
  --max_seq_length 2048
```

The LoRA adapter weights will be saved to `outputs/jellyfish-agent-lora/`.

### Merge + Export to GGUF (Optional)

To serve with Ollama, merge the adapter and export:

```python
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained("outputs/jellyfish-agent-lora")
model.save_pretrained_gguf("outputs/jellyfish-agent-gguf", tokenizer, quantization_method="q4_k_m")
```

Then in Ollama:
```bash
ollama create jellyfish-agent -f ./Modelfile
```

---

## Step 3 — Serve the Model

### Option A: vLLM (Recommended for production)

```bash
pip install vllm
python -m vllm.entrypoints.openai.api_server \
  --model outputs/jellyfish-agent-lora \
  --host 0.0.0.0 \
  --port 8000
```

### Option B: Ollama (Local / simpler)

```bash
ollama serve
# Then in a separate terminal:
ollama run jellyfish-agent
```

The server exposes an OpenAI-compatible endpoint:
`http://<your-server-ip>:8000/v1/chat/completions`

---

## Step 4 — Connect to Jellyfish

In `packages/worker/wrangler.toml`, uncomment and set:

```toml
[vars]
CUSTOM_LLM_URL = "http://your-gpu-server-ip:8000/v1/chat/completions"
# GEMINI_MODEL still controls the model name sent in the request body
# e.g. GEMINI_MODEL = "jellyfish-agent" or your Ollama model name
```

For the API key (if your server requires auth):
```bash
npx wrangler secret put CUSTOM_LLM_KEY
```

Once set, **all LLM calls** (reply generation, spontaneous tweets, timeline evaluation, and personality evolution) will automatically route to your fine-tuned model. ReAct chain-of-thought is stripped server-side before the text is posted to Twitter.

---

## Notes

- The dataset generator uses the **teacher model** (your current `GEMINI_MODEL`) to synthesise training data, so you need it configured and working first.
- More dataset = better model. Run the generator 10–20 times and concatenate the JSONL files.
- `max_steps = 60` in the training script is intentionally conservative. For a full dataset of 100+ examples, increase to 200–500.
- Keep `CUSTOM_LLM_URL` empty to revert to Gemini/Grok at any time — no other code changes needed.
