# 本地模型复核：2026-09-24

本记录对应上游 #5039 `235c3953e3afb60447a29a692d5a3b23e28bcd53` 的窄数据
候选。它只维护随包 Registry 的本地候选，不代表外部 Cindy Model Access 已同步，
也不代表模型已经下载、安装或在本机完成推理验收。

## 本轮结论

目录从 7 个逻辑模型增加到 8 个：新增 Laguna S 2.1 118B A8B，并为
Qwen3.8 Flash-Next 增加官方跨平台 Q4 包装。`featuredIds` 仍只有
`qwen38-27b`；新增条目是可搜索、可手动选择的候选，不自动推荐或切换用户模型。
本轮没有下载权重、启动 Ollama 推理或改变真实用户资料。

## 一级材料与候选边界

| 候选 | 采用的材料 | 已写入的事实 | 保持未知的事实 |
| --- | --- | --- | --- |
| Qwen3.8 Flash-Next | [官方模型卡](https://huggingface.co/Qwen/Qwen3.8-Flash-Next)、[Ollama 标签](https://ollama.com/library/qwen3.8-flash-next/tags)、[Rapid-MLX 测试](https://huggingface.co/rapid-mlx/Qwen3.8-Flash-Next-4bit) | `125b-mlx` 与 `125b-a6b-q4_K_M` 标签及下载字节；192 GB 保守提示 | Ollama 加载/运行峰值、速度、工具多轮和量化后的能力；MLX 测试不冒充 Ollama 实测 |
| Laguna S 2.1 | [官方模型卡](https://huggingface.co/poolside/Laguna-S-2.1)、[Ollama 标签](https://ollama.com/library/laguna-s-2.1/tags)、[独立测试记录](https://github.com/tanishq-dubey/macos-laguna-s2.1/blob/main/BENCHMARK_RESULTS.md) | 118B 总参数、8B 激活、1,048,576 原生窗口；`nvfp4` 与 `q4_K_M` 标签及下载字节 | Ollama 工具调用、速度、峰值内存、满上下文可用性；社区 MLX 结果不冒充官方包装实测 |

模型卡中的厂商/社区 benchmark 只说明研究资格，不构成同机能力胜出证明。MoE
激活参数不能替代权重占用；下载字节也不是加载或稳定运行内存。

## 包装与门槛

| 标签 | layers 字节 | 候选门槛 | 平台 |
| --- | ---: | ---: | --- |
| `qwen3.8-flash-next:125b-mlx` | 104852025885 | 192 GB | Apple Silicon |
| `qwen3.8-flash-next:125b-a6b-q4_K_M` | 120058268208 | 192 GB | 通用 |
| `laguna-s-2.1:nvfp4` | 66189691080 | 128 GB | Apple Silicon |
| `laguna-s-2.1:q4_K_M` | 96031832391 | 192 GB | 通用 |

门槛是为系统、权重和缓存预留空间的保守产品提示，不是最低运行内存证明。
`localModelRuntime.ts` 只识别精确的 `nvfp4`、`mlx`、`mxfp8` 与 Q4 标签；未知
量化不会被归类为已知包装。

## 推荐与后续验收

- Qwen3.8 27B 仍是唯一 featured 推荐；Flash-Next 与 Laguna 保持候选，不因内存
  足够而自动晋升。
- 正式晋升前须在同一硬件、Ollama 版本、思考预算与上下文下比较能力、速度和
  系统峰值内存，并记录冷/热启动、TTFT、生成速度、完整耗时、swap 与波动。
- 标签可变，后续更新必须重新读取 manifest 并记录观察日期；本文件和 Registry
  不宣称固定权重 digest、外部部署或生产可用性。
