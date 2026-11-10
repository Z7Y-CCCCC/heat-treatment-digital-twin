using System;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Jobs;

namespace HeatTreatment.DigitalTwin.Rendering
{
    // Change detection only. Exact picks still use the real renderer bounds,
    // render matrix and triangle BVH. Complete in this same frame: no delayed
    // pose, consumed hasChanged flags, guessed envelopes or hidden pick throttle.
    public sealed class HoverTransformBatch : IDisposable
    {
        private TransformAccessArray _transforms;
        private NativeArray<Matrix4x4> _matrices;
        public int Count => _matrices.IsCreated ? _matrices.Length : 0;
        private struct ReadMatrices : IJobParallelForTransform
        {
            [WriteOnly] public NativeArray<Matrix4x4> Matrices;
            public void Execute(int index, TransformAccess transform)
                => Matrices[index] = transform.isValid ? transform.localToWorldMatrix : Matrix4x4.identity;
        }
        public void SetTransforms(Transform[] transforms)
        {
            Dispose();
            if (transforms == null || transforms.Length == 0) return;
            _transforms = new TransformAccessArray(transforms);
            _matrices = new NativeArray<Matrix4x4>(transforms.Length, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
        }
        public void Capture()
        {
            if (!_matrices.IsCreated) return;
            new ReadMatrices { Matrices = _matrices }.ScheduleReadOnly(_transforms, 64).Complete();
        }
        public Matrix4x4 Get(int index) => _matrices[index];
        public void Dispose()
        {
            if (_transforms.isCreated) _transforms.Dispose();
            if (_matrices.IsCreated) _matrices.Dispose();
        }
    }
}
