using System;
using System.Collections.Generic;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    /// <summary>CPU-only BVH. Original triangles, winding and vertices are untouched.</summary>
    public sealed class TriangleRayIndex
    {
        private readonly struct ParametricRay
        {
            public readonly Vector3 origin, direction;
            public ParametricRay(Vector3 origin, Vector3 direction) { this.origin = origin; this.direction = direction; }
        }
        private struct Node
        {
            public Vector3 Min, Max;
            public int Start, Count, Left, Right;
        }
        private readonly Vector3[] _vertices;
        private readonly int[] _triangles;
        private readonly int[] _order;
        private readonly List<Node> _nodes;
        public int LastTriangleTests { get; private set; }

        public TriangleRayIndex(Vector3[] vertices, int[] triangles, bool indexed = true)
        {
            _vertices = vertices; _triangles = triangles;
            if (!indexed || triangles.Length <= 64 * 3) return;
            _order = new int[triangles.Length / 3];
            for (var i = 0; i < _order.Length; i++) _order[i] = i;
            _nodes = new List<Node>(_order.Length / 4);
            Build(0, _order.Length);
        }

        private Vector3 Center(int triangle)
        {
            var i = triangle * 3;
            return (_vertices[_triangles[i]] + _vertices[_triangles[i + 1]] + _vertices[_triangles[i + 2]]) / 3f;
        }

        private int Build(int start, int count)
        {
            var min = new Vector3(float.PositiveInfinity, float.PositiveInfinity, float.PositiveInfinity);
            var max = new Vector3(float.NegativeInfinity, float.NegativeInfinity, float.NegativeInfinity);
            var centerMin = min; var centerMax = max;
            for (var i = start; i < start + count; i++)
            {
                var triangle = _order[i] * 3;
                for (var vertex = 0; vertex < 3; vertex++)
                {
                    var point = _vertices[_triangles[triangle + vertex]];
                    min = Vector3.Min(min, point); max = Vector3.Max(max, point);
                }
                var center = Center(_order[i]);
                centerMin = Vector3.Min(centerMin, center); centerMax = Vector3.Max(centerMax, center);
            }
            var node = new Node { Min = min, Max = max, Start = start, Count = count };
            var index = _nodes.Count; _nodes.Add(node);
            var span = centerMax - centerMin;
            var axis = span.x >= span.y && span.x >= span.z ? 0 : span.y >= span.z ? 1 : 2;
            if (count <= 12 || span[axis] <= 1e-12f) return index;
            Array.Sort(_order, start, count, Comparer<int>.Create((a, b) => Center(a)[axis].CompareTo(Center(b)[axis])));
            var middle = count / 2;
            node.Count = 0;
            node.Left = Build(start, middle); node.Right = Build(start + middle, count - middle);
            _nodes[index] = node;
            return index;
        }

        public bool Raycast(Vector3 origin, Vector3 direction, out float distance, Func<float, bool> acceptDistance = null)
        {
            // UnityEngine.Ray's constructor normalizes its direction. Keep the
            // inverse-transformed direction unnormalized for world distances.
            var localRay = new ParametricRay(origin, direction);
            LastTriangleTests = 0;
            var nearest = float.PositiveInfinity;
            if (_nodes == null)
            {
                for (var triangle = 0; triangle + 2 < _triangles.Length; triangle += 3)
                    TestTriangle(triangle, localRay, acceptDistance, ref nearest);
            }
            else Visit(0, localRay, acceptDistance, ref nearest);
            distance = nearest;
            return !float.IsPositiveInfinity(distance);
        }

        private static bool Intersects(Node node, ParametricRay ray, float nearest, out double entry)
        {
            entry = 0d; var exit = (double)nearest;
            for (var axis = 0; axis < 3; axis++)
            {
                var origin = (double)ray.origin[axis]; var direction = (double)ray.direction[axis];
                // Triangle tests intentionally retain their original float math.
                // A rounded edge/vertex hit may lie just outside its exact AABB;
                // tolerate that roundoff in broad-phase only. Include origin
                // magnitude because distant rays lose precision in subtraction.
                const double floatError = 8d / 8388608d;
                var padding = floatError * (Math.Abs(origin)
                    + Math.Max(Math.Abs((double)node.Min[axis]), Math.Abs((double)node.Max[axis])) + 1d);
                var minimum = node.Min[axis] - padding;
                var maximum = node.Max[axis] + padding;
                if (direction == 0d)
                {
                    if (origin < minimum || origin > maximum) return false;
                    continue;
                }
                var a = (minimum - origin) / direction;
                var b = (maximum - origin) / direction;
                entry = Math.Max(entry, Math.Min(a, b)); exit = Math.Min(exit, Math.Max(a, b));
                if (entry > exit) return false;
            }
            return true;
        }

        private void Visit(int index, ParametricRay ray, Func<float, bool> accept, ref float nearest)
        {
            var node = _nodes[index];
            if (!Intersects(node, ray, nearest, out _)) return;
            if (node.Count != 0)
            {
                for (var i = node.Start; i < node.Start + node.Count; i++) TestTriangle(_order[i] * 3, ray, accept, ref nearest);
                return;
            }
            var leftHit = Intersects(_nodes[node.Left], ray, nearest, out var leftEntry);
            var rightHit = Intersects(_nodes[node.Right], ray, nearest, out var rightEntry);
            if (leftHit && rightHit)
            {
                var first = leftEntry <= rightEntry ? node.Left : node.Right;
                var second = leftEntry <= rightEntry ? node.Right : node.Left;
                Visit(first, ray, accept, ref nearest); Visit(second, ray, accept, ref nearest);
            }
            else if (leftHit) Visit(node.Left, ray, accept, ref nearest);
            else if (rightHit) Visit(node.Right, ray, accept, ref nearest);
        }

        private void TestTriangle(int i, ParametricRay ray, Func<float, bool> accept, ref float nearest)
        {
            LastTriangleTests++;
            var a = _vertices[_triangles[i]];
            var edge1 = _vertices[_triangles[i + 1]] - a;
            var edge2 = _vertices[_triangles[i + 2]] - a;
            var cross = Vector3.Cross(ray.direction, edge2);
            var determinant = Vector3.Dot(edge1, cross);
            if (Math.Abs(determinant) < 1e-10f) return;
            var reciprocal = 1f / determinant; var fromA = ray.origin - a;
            var u = Vector3.Dot(fromA, cross) * reciprocal;
            if (u < 0f || u > 1f) return;
            var q = Vector3.Cross(fromA, edge1);
            var v = Vector3.Dot(ray.direction, q) * reciprocal;
            if (v < 0f || u + v > 1f) return;
            var hit = Vector3.Dot(edge2, q) * reciprocal;
            if (hit < 0f || hit >= nearest || (accept != null && !accept(hit))) return;
            nearest = hit;
        }
    }
}
