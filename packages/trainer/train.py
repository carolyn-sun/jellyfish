"""
Jellyfish Agent - QLoRA Fine-tuning Script with Unsloth

Prerequisites:
- NVIDIA GPU with ≥16 GB VRAM (A10G / A100 / RTX 4090 tested)
- pip install -r requirements.txt

⚠️  Minimum effective dataset: ~100 JSONL examples.
    Use the Dashboard "Generate Dataset" button multiple times and concatenate files:
        cat dataset_*.jsonl > combined.jsonl

Usage:
    python train.py \\
        --dataset_path combined.jsonl \\
        --model_name unsloth/Llama-3-8b-Instruct-bnb-4bit \\
        --num_epochs 3 \\
        --output_dir outputs/jellyfish-agent-lora
"""

import argparse
import os
import sys

from unsloth import FastLanguageModel
import torch
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments

MIN_RECOMMENDED_SAMPLES = 50


def main():
    parser = argparse.ArgumentParser(description="Jellyfish Agent QLoRA fine-tuning")
    parser.add_argument('--dataset_path', type=str, required=True,
                        help='Path to the ReAct JSONL dataset')
    parser.add_argument('--model_name', type=str,
                        default='unsloth/Llama-3-8b-Instruct-bnb-4bit',
                        help='Base model (Hugging Face ID or unsloth/ prefixed)')
    parser.add_argument('--max_seq_length', type=int, default=2048)
    parser.add_argument('--output_dir', type=str, default='outputs/jellyfish-agent-lora')
    parser.add_argument('--num_epochs', type=int, default=3,
                        help='Training epochs. Controls how many times the dataset is seen.')
    parser.add_argument('--max_steps', type=int, default=-1,
                        help='Override epochs with a fixed step count. Use -1 (default) to let '
                             '--num_epochs control length.')
    parser.add_argument('--lora_r', type=int, default=16,
                        help='LoRA rank. Higher = more capacity, more VRAM.')
    parser.add_argument('--learning_rate', type=float, default=2e-4)
    args = parser.parse_args()

    # ── Validate dataset ──────────────────────────────────────────────────────
    if not os.path.exists(args.dataset_path):
        print(f"[ERROR] Dataset file not found: {args.dataset_path}", file=sys.stderr)
        sys.exit(1)

    with open(args.dataset_path, 'r', encoding='utf-8') as f:
        lines = [l.strip() for l in f if l.strip()]
    print(f"[info] Dataset: {len(lines)} examples in {args.dataset_path}")

    if len(lines) < MIN_RECOMMENDED_SAMPLES:
        print(
            f"\n[WARNING] Only {len(lines)} training examples found.\n"
            f"  Effective fine-tuning needs ≥{MIN_RECOMMENDED_SAMPLES} samples.\n"
            f"  Run the Dashboard generator multiple times, then:\n"
            f"    cat dataset_*.jsonl > combined.jsonl\n"
            f"  Training will proceed but expect overfitting on small datasets.\n",
            file=sys.stderr
        )

    # ── Load model ────────────────────────────────────────────────────────────
    print(f"[info] Loading base model: {args.model_name}")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model_name,
        max_seq_length=args.max_seq_length,
        dtype=None,          # auto-detect: bf16 on Ampere+, fp16 otherwise
        load_in_4bit=True,
    )

    # ── Attach LoRA adapters ──────────────────────────────────────────────────
    print(f"[info] Attaching LoRA adapters (r={args.lora_r})")
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
        lora_alpha=args.lora_r,   # alpha == r is a safe, well-tested default
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )

    # ── Load dataset ──────────────────────────────────────────────────────────
    dataset = load_dataset("json", data_files=args.dataset_path, split="train")

    # ── Apply chat template ──────────────────────────────────────────────────
    # The dataset now contains a "messages" field (system/user/assistant).
    # We must convert it to the model's native token format using apply_chat_template,
    # so that training token sequences EXACTLY match what vLLM/Ollama produces at
    # inference time. Without this, the model learns from a different token layout
    # than it sees during deployment, making fine-tuning largely ineffective.
    print("[info] Applying chat template to dataset...")
    def format_with_chat_template(examples):
        texts = []
        for messages in examples["messages"]:
            text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=False,
            )
            texts.append(text)
        return {"text": texts}

    dataset = dataset.map(
        format_with_chat_template,
        batched=True,
        desc="Applying chat template",
    )
    print(f"[info] Chat template applied. First example preview:\n{dataset[0]['text'][:300]}...")

    # ── Build TrainingArguments ───────────────────────────────────────────────
    log_every = max(1, len(lines) // 20)   # log ~20 times per run
    training_kwargs: dict = dict(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        warmup_ratio=0.05,
        learning_rate=args.learning_rate,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=log_every,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="cosine",
        seed=3407,
        output_dir=args.output_dir,
        save_strategy="epoch",
        report_to="none",   # disable wandb/tensorboard by default
    )

    if args.max_steps > 0:
        training_kwargs["max_steps"] = args.max_steps
        print(f"[info] Training for {args.max_steps} steps (max_steps override active)")
    else:
        training_kwargs["num_train_epochs"] = args.num_epochs
        print(f"[info] Training for {args.num_epochs} epoch(s)")

    # ── Train ─────────────────────────────────────────────────────────────────
    print("[info] Starting QLoRA fine-tuning...")
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=args.max_seq_length,
        dataset_num_proc=2,
        packing=False,  # packing=True hurts small datasets by merging all samples into one sequence
        args=TrainingArguments(**training_kwargs),
    )

    stats = trainer.train()
    print(f"[info] Training complete. {stats}")

    # ── Save ──────────────────────────────────────────────────────────────────
    print(f"[info] Saving LoRA adapter to {args.output_dir}/ ...")
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)

    print(
        f"\n[info] Done! Next steps:\n"
        f"  1. Serve the adapter:\n"
        f"       python -m vllm.entrypoints.openai.api_server \\\n"
        f"           --model {args.output_dir} --host 0.0.0.0 --port 8000\n"
        f"  2. Set in wrangler.toml:\n"
        f"       CUSTOM_LLM_URL   = \"http://<server>:8000/v1/chat/completions\"\n"
        f"       CUSTOM_LLM_MODEL = \"{os.path.basename(args.output_dir)}\"\n"
        f"  3. pnpm deploy\n"
    )


if __name__ == '__main__':
    main()
