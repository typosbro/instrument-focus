"""Cut the inverse STFT out of the htdemucs_6s web graph.

The upstream export ends in a ~16k-node inverse STFT (/real_istft: Slice, ScatterND,
Shape chains). onnxruntime-web runs much of it on the WASM fallback, so every window
crossed GPU -> CPU -> GPU, and those nodes carried ~41 MB of constants. This keeps
everything up to the two tensors the iSTFT combines and makes them the outputs:

  spec  float32 [1, 6, 2, 2, 2049, 340]  padded spectrogram (re/im as a dim)
  wave  float32 [1, 6, 2, 343980]        time branch

The worker computes stems = wave + istft(spec)[1536 : 1536 + 343980] in JS
(makeIstft in extension/src/engine.worker.js). Parity against the full graph:
max |diff| 5.95e-05 on a 0.46 peak (extension/test/istft_check.mjs).
Nothing upstream of the cut changes: both outputs are bit-identical to the
full graph's intermediate tensors.
"""
import argparse

import onnx
from onnx import TensorProto, helper

ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ap.add_argument("--src", required=True)
ap.add_argument("--dst", required=True)
a = ap.parse_args()

CUT = {"/Pad_2_output_0": "spec", "/Add_4_output_0": "wave"}

m = onnx.load(a.src)
g = m.graph
prod = {o: n for n in g.node for o in n.output}
missing = [t for t in CUT if t not in prod]
if missing:
    raise SystemExit("cut points not found (different export?): %s" % missing)

keep, stack = set(), list(CUT)
while stack:
    n = prod.get(stack.pop())
    if n is None or id(n) in keep:
        continue
    keep.add(id(n))
    stack.extend(i for i in n.input if i)
nodes = [n for n in g.node if id(n) in keep]
used = {i for n in nodes for i in n.input}
inits = [i for i in g.initializer if i.name in used]

for n in nodes:
    for k, o in enumerate(n.output):
        n.output[k] = CUT.get(o, o)
    for k, i in enumerate(n.input):
        n.input[k] = CUT.get(i, i)

del g.node[:]
g.node.extend(nodes)
del g.initializer[:]
g.initializer.extend(inits)
del g.value_info[:]
del g.output[:]
g.output.extend([
    helper.make_tensor_value_info("spec", TensorProto.FLOAT, [1, 6, 2, 2, 2049, 340]),
    helper.make_tensor_value_info("wave", TensorProto.FLOAT, [1, 6, 2, 343980]),
])
onnx.checker.check_model(m)
onnx.save(m, a.dst)
print("kept %d nodes, %d initializers" % (len(nodes), len(inits)))
