using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace HeatTreatment.DigitalTwin.Rendering
{
    public sealed class InspectionFeatureEdgeOverlay : MonoBehaviour { }

    // Weld CAD face splits, then retain boundaries and sharp folds only.
    // Coplanar triangulation diagonals and smooth cylinder facets stay hidden.
    public static class InspectionFeatureEdges
    {
        private struct Edge
        {
            public int A, B, Count;
            public Vector3 Normal;
            public bool Sharp;
        }

        public static Mesh Build(Mesh source)
        {
            if (source == null || !source.isReadable) return null;
            var vertices = source.vertices;
            var triangles = source.triangles;
            var epsilon = Mathf.Max(source.bounds.size.magnitude * .000001f, .0000001f);
            var origin = source.bounds.min;
            var welded = new Dictionary<Vector3Int, int>();
            var points = new List<Vector3>();
            var ids = new int[vertices.Length];
            for (var i = 0; i < vertices.Length; i++)
            {
                var p = (vertices[i] - origin) / epsilon;
                var key = new Vector3Int(Mathf.RoundToInt(p.x), Mathf.RoundToInt(p.y), Mathf.RoundToInt(p.z));
                if (!welded.TryGetValue(key, out var id))
                {
                    id = points.Count; welded.Add(key, id); points.Add(vertices[i]);
                }
                ids[i] = id;
            }
            var edges = new Dictionary<ulong, Edge>();
            void Add(int a, int b, Vector3 normal)
            {
                if (a == b) return;
                if (a > b) { var swap = a; a = b; b = swap; }
                var key = ((ulong)(uint)a << 32) | (uint)b;
                if (!edges.TryGetValue(key, out var edge)) edge = new Edge { A = a, B = b, Normal = normal };
                else if (Mathf.Abs(Vector3.Dot(edge.Normal, normal)) < .819152f) edge.Sharp = true;
                edge.Count++; edges[key] = edge;
            }
            for (var i = 0; i + 2 < triangles.Length; i += 3)
            {
                var a = ids[triangles[i]]; var b = ids[triangles[i + 1]]; var c = ids[triangles[i + 2]];
                var normal = Vector3.Cross(points[b] - points[a], points[c] - points[a]);
                if (normal.sqrMagnitude < epsilon * epsilon * epsilon * epsilon) continue;
                normal.Normalize(); Add(a, b, normal); Add(b, c, normal); Add(c, a, normal);
            }
            var indices = new List<int>();
            foreach (var edge in edges.Values)
                if (edge.Count == 1 || edge.Sharp) { indices.Add(edge.A); indices.Add(edge.B); }
            if (indices.Count == 0) return null;
            var result = new Mesh { name = "Inspection structural edges: " + source.name, hideFlags = HideFlags.DontSave,
                indexFormat = points.Count > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            result.SetVertices(points); result.SetIndices(indices, MeshTopology.Lines, 0);
            result.bounds = source.bounds;
            return result;
        }
    }
}
