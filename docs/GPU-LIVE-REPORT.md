# Native NVIDIA device validation

Recorded on 2026-10-24 (Asia/Shanghai) for the `0.3.0-beta.5` fix. The host ran Ubuntu 24.04, Linux 6.14, eight RTX 3090 GPUs and NVIDIA driver 575.64.03. All probes used the same existing Python environment: PyTorch 2.7.1+cu126, CUDA build 12.6. No Python packages or drivers were changed.

## Reproduction and fix

The host contained `/dev/nvidia0` through `/dev/nvidia7`, `/dev/nvidiactl`, `/dev/nvidia-uvm`, `/dev/nvidia-uvm-tools` and `/dev/nvidia-modeset`. Beta.4 mounted the numbered/control devices but its regular expression omitted the hyphens in the last three names. Seeing GPUs in `nvidia-smi` or through NVML was therefore insufficient to establish CUDA availability.

The comparison ran three fresh subprocesses: directly on the host, through the installed beta.4 namespace builder, and through the patched namespace builder. `CUDA_VISIBLE_DEVICES=0` was set before every subprocess started.

| Check | Host | Beta.4 isolation | Patched isolation |
| --- | --- | --- | --- |
| UVM, UVM-tools and modeset device nodes | Present | Missing | Present, matching host device numbers |
| Driver `cuInit(0)` | 0 (success) | 999 (unknown error) | 0 (success) |
| Driver device count after successful initialization | 1 | Initialization failed | 1 |
| `torch.cuda.is_available()` | true | false | true |
| `torch.cuda.is_initialized()` | false | false | false |
| Direct external IPv4 connection | Not tested | `ENETUNREACH` | `ENETUNREACH` |

Device discovery also now uses `lstat` rather than directory-entry type: a character device bound onto a file mountpoint can report a regular-file directory entry even though its mounted inode is a character device. `lstat` recognizes that case without following symlinks.

## Scope

The diagnostic initialized the CUDA driver and queried device availability. It did **not** create a PyTorch CUDA context, allocate GPU tensors, launch kernels, start another scheduler or interrupt existing GPU jobs. The running scheduler's status timestamp advanced throughout the comparison. Native kernel execution, multi-GPU collectives and AMD/ROCm are not claimed by this test. Earlier WSL CUDA matrix multiplication is recorded separately in the [SDK/GPU report](VSCODE-LIVE-REPORT.md).

The regression test uses a private `/dev` with real character-device bind mounts under the supported names, so it exercises discovery and mount arguments on CPU-only CI runners. It also rejects misspelled NVIDIA names, unrelated devices, ordinary files and symlinks.

The fix applies to both CLI and VS Code launches through their shared isolation module. Upgrade and start a new Claude process; package replacement cannot repair the mount table of an existing session. A missing device on the host itself remains a host-driver issue.
