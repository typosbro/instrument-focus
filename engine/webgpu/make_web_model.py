"""Convert every float64 (DOUBLE) construct in the htdemucs_6s ONNX graph to float32.

onnxruntime-web's wasm backend is built with a reduced type list: no float64 kernels.
The published export computes its iSTFT reconstruction in float64, so the web build
refuses the session ('no implementation for ConstantOfShape(9)/Cast(13)').
Everything in that region is Add/Expand/Reshape/ScatterND/Slice arithmetic, so a
global double->float32 rewrite is type-consistent. Parity is verified separately.
"""
import numpy as np
import onnx
from onnx import TensorProto, numpy_helper

import argparse
_ap = argparse.ArgumentParser(description="Rewrite float64 constants to float32 so onnxruntime-web can load the model.")
_ap.add_argument("--src", default="models/htdemucs_6s.onnx")
_ap.add_argument("--dst", default="models/htdemucs_6s_web.onnx")
_a = _ap.parse_args()
SRC = _a.src
DST = _a.dst

m = onnx.load(SRC, load_external_data=False)
stats = {"cast": 0, "constant": 0, "cos": 0, "initializer": 0}


def to_float_tensor(t):
    if t.data_type != TensorProto.DOUBLE:
        return 0
    arr = numpy_helper.to_array(t).astype(np.float32)
    raw = arr.tobytes()
    n = 1
    for d in t.dims:
        n *= d
    return raw


for n in m.graph.node:
    if n.op_type == "Cast":
        for a in n.attribute:
            if a.name == "to" and a.i == TensorProto.DOUBLE:
                a.i = TensorProto.FLOAT
                stats["cast"] += 1
    elif n.op_type == "Constant":
        for a in n.attribute:
            if a.name == "value" and a.t.data_type == TensorProto.DOUBLE:
                arr = numpy_helper.to_array(a.t).astype(np.float32)
                a.t.data_type = TensorProto.FLOAT
                a.t.raw_data = arr.tobytes()
                stats["constant"] += 1
    elif n.op_type == "ConstantOfShape":
        for a in n.attribute:
            if a.name == "value" and a.t.data_type == TensorProto.DOUBLE:
                a.t.data_type = TensorProto.FLOAT
                a.t.raw_data = np.array([0.0], dtype=np.float32).tobytes()
                stats["cos"] += 1

for init in m.graph.initializer:
    if init.data_type == TensorProto.DOUBLE:
        arr = numpy_helper.to_array(init).astype(np.float32)
        init.data_type = TensorProto.FLOAT
        init.raw_data = arr.tobytes()
        del init.float_data[:]
        del init.double_data[:]
        stats["initializer"] += 1

onnx.save(m, DST)
print("converted:", stats)
