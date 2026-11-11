#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using HeatTreatment.DigitalTwin.Rendering;
using HeatTreatment.DigitalTwin.Runtime;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Editor
{
    public static class InspectionIndexBatchValidation
    {
        private sealed class Pump : SynchronizationContext
        {
            private readonly ConcurrentQueue<Action> _pending = new ConcurrentQueue<Action>();
            public int Posts;
            public override void Post(SendOrPostCallback callback, object state) { Interlocked.Increment(ref Posts); _pending.Enqueue(() => callback(state)); }
            public void Complete(Task task) {
                var timeout = System.Diagnostics.Stopwatch.StartNew();
                while (!task.IsCompleted) {
                    if (timeout.Elapsed.TotalSeconds > 20) throw new InvalidOperationException("Index batch validation did not complete");
                    if (_pending.TryDequeue(out var next)) next(); else Thread.Sleep(1);
                }
                task.GetAwaiter().GetResult();
            }
        }

        public static void Validate()
        {
            var original = SynchronizationContext.Current; var pump = new Pump(); var thread = Thread.CurrentThread.ManagedThreadId;
            var root = new GameObject("__IndexBatchValidation"); var meshes = new List<Mesh>(); var checks = 0;
            void Check(bool value, string why) { if (!value) throw new InvalidOperationException(why); checks++; }
            try {
                SynchronizationContext.SetSynchronizationContext(pump);
                for (var i = 0; i < 120; i++) {
                    var child = new GameObject("mesh-" + i); child.transform.SetParent(root.transform, false);
                    var mesh = new Mesh { vertices = new[] { Vector3.zero, Vector3.right, Vector3.up }, triangles = new[] { 0, 1, 2 } };
                    mesh.RecalculateBounds(); meshes.Add(mesh);
                    child.AddComponent<MeshFilter>().sharedMesh = mesh; child.AddComponent<MeshRenderer>();
                }
                var duplicate = new GameObject("shared-mesh"); duplicate.transform.SetParent(root.transform, false); duplicate.AddComponent<MeshFilter>().sharedMesh = meshes[0];
                var updates = new List<int>();
                pump.Complete(InspectionMeshSurface.PrepareStaticIndexesAsync(root, CancellationToken.None, (done,total) => {
                    Check(Thread.CurrentThread.ManagedThreadId == thread, "Unity mesh progress left its owning thread");
                    Check(total == 120, "Shared geometry was indexed twice"); updates.Add(done);
                }));
                Check(updates.Count == 3 && updates[0] == 0 && updates[1] == 64 && updates[2] == 120, "Tiny CAD meshes were not built in batches of 64");
                Check(pump.Posts <= 2, "A continuation per mesh still imposes one Unity frame per tiny mesh");
                foreach (var renderer in root.GetComponentsInChildren<MeshRenderer>()) {
                    using (var surface = new InspectionMeshSurface(renderer)) {
                        Check(surface.Raycast(new Ray(new Vector3(.2f,.2f,-1),Vector3.forward),out var distance) && Mathf.Abs(distance-1)<.00001f, "Batching changed exact triangle picking");
                        Check(!surface.Raycast(new Ray(new Vector3(.9f,.9f,-1),Vector3.forward),out _), "Triangle geometry was replaced by its bounds");
                    }
                }
                var posts = pump.Posts; var cached = 0;
                pump.Complete(InspectionMeshSurface.PrepareStaticIndexesAsync(root, CancellationToken.None, (done,total) => { Check(done==0&&total==0,"Cached geometry was rebuilt"); cached++; }));
                Check(cached==1&&pump.Posts==posts,"Cached loads scheduled unnecessary workers");
                using (var cancellation = new CancellationTokenSource()) {
                    cancellation.Cancel(); var cancelled = false;
                    try { pump.Complete(InspectionMeshSurface.PrepareStaticIndexesAsync(root, cancellation.Token)); } catch (OperationCanceledException) { cancelled=true; }
                    Check(cancelled,"Cancelled model work was not stopped");
                }
                var camera = root.AddComponent<Camera>();
                var projection = camera.projectionMatrix; var gate = new StartupSceneRenderGate(camera);
                gate.Pause(); Check(!camera.enabled,"Covered CAD scene still renders during loading");
                gate.Pause(); gate.Resume(); Check(camera.enabled,"A retry forgot the original enabled camera state");
                Check(camera.projectionMatrix.Equals(projection),"Loading changed the authored camera projection");
                camera.enabled=false; gate.Pause(); gate.Resume(); Check(!camera.enabled,"Loading enabled a camera that was originally disabled");
                camera.enabled=true; gate.Resume(); Check(camera.enabled,"An idle resume changed another owner's camera state");
                gate.Pause(); UnityEngine.Object.DestroyImmediate(camera); gate.Resume();
                Check(true,"Camera destruction during cancelled startup is safe");
                Debug.Log($"[InspectionIndexBatchValidation] PASS {checks} checks; 120 unique meshes, <=2 main-thread continuations, exact hits/misses, cache and cancellation");
            }
            finally {
                SynchronizationContext.SetSynchronizationContext(original);
                UnityEngine.Object.DestroyImmediate(root);
                foreach (var mesh in meshes) UnityEngine.Object.DestroyImmediate(mesh);
            }
        }
    }
}
#endif
