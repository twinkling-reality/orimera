"""A small perspective renderer: convex solids to pixels, with real multi-view consistency.

This is not a graphics library and does not want to be. It is the smallest renderer that
produces genuinely multi-view-consistent photographs: a pinhole camera, near-plane clipping,
backface culling, painter's-algorithm depth sorting over faces, and flat shading from one
directional light.

**Why it is real geometry rather than a collage.** The corpus exists to exercise scene grouping
now and single-image reconstruction later, and both are answering a question about a physical
arrangement. Frames pasted together from sprites would let a reconstruction stage appear to work
on input that has no consistent depth to recover, which is the same failure this project has
already found twice in its own test suite: a harness that passes on the wrong target. Every
frame here is a projection of one 3D arrangement through a camera whose pose is recorded, so
overlapping frames genuinely overlap, and the depth a reconstruction recovers can be compared
against the depth the camera actually used.

**What it deliberately does not do.** No shadows, no reflection, no anti-aliasing beyond what
supersampling gives, no texture. Each of those would make the images prettier and none would
make them more useful, because the properties under test are geometric rather than photometric.

Painter's algorithm is exact for the arrangements this package builds, because every solid is
convex and no two solids interpenetrate. That is a property of `world.py`, not of this file, and
it is stated in both places so that adding an intersecting solid is recognised as changing the
correctness of the renderer rather than as adding a shape.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

from PIL import Image, ImageDraw, ImageFilter

__all__ = [
    "Camera",
    "Face",
    "Light",
    "Vec3",
    "cross",
    "dot",
    "normalize",
    "render",
    "scale",
    "sub",
]

Vec3 = tuple[float, float, float]

#: Camera-space depth at which geometry is clipped. Anything nearer is behind the lens.
_NEAR: Final = 0.05

#: The image is rendered at this multiple of the requested size and then reduced. Cheaper than a
#: real anti-aliaser and, unlike a blur, it does not move an edge away from where the geometry
#: actually put it.
_SUPERSAMPLE: Final = 2


def sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def scale(a: Vec3, k: float) -> Vec3:
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def length(a: Vec3) -> float:
    return math.sqrt(dot(a, a))


def normalize(a: Vec3) -> Vec3:
    magnitude = length(a)
    if magnitude == 0.0:
        raise ValueError("cannot normalize a zero vector")
    return scale(a, 1.0 / magnitude)


@dataclass(frozen=True, slots=True)
class Face:
    """One convex planar polygon, wound counter-clockwise as seen from outside the solid.

    The winding is what backface culling reads, so a face wound the wrong way is invisible
    rather than merely wrong. `world.py` builds every face through helpers that get the winding
    right once, so no caller has to reason about it.
    """

    vertices: tuple[Vec3, ...]
    colour: tuple[int, int, int]

    def normal(self) -> Vec3:
        """The outward normal, by Newell's method.

        Newell rather than a cross product of the first three edges: a face whose first three
        vertices happen to be nearly collinear produces a near-zero cross product and a normal
        that points somewhere arbitrary. Newell sums over every edge, so it is stable for any
        polygon that has an area at all.
        """
        nx = ny = nz = 0.0
        count = len(self.vertices)
        for index in range(count):
            current = self.vertices[index]
            following = self.vertices[(index + 1) % count]
            nx += (current[1] - following[1]) * (current[2] + following[2])
            ny += (current[2] - following[2]) * (current[0] + following[0])
            nz += (current[0] - following[0]) * (current[1] + following[1])
        return normalize((nx, ny, nz))


@dataclass(frozen=True, slots=True)
class Camera:
    """A pinhole camera. The pose is data, because the corpus manifest records it.

    World up is +Z. That is the convention the whole package uses and it is stated here because
    a renderer that silently assumed +Y would put every horizon in the wrong place.
    """

    eye: Vec3
    target: Vec3
    horizontal_fov_degrees: float
    width: int
    height: int
    up: Vec3 = (0.0, 0.0, 1.0)

    def basis(self) -> tuple[Vec3, Vec3, Vec3]:
        """Right, up and forward, orthonormal. Forward is +Z in camera space."""
        forward = normalize(sub(self.target, self.eye))
        right = normalize(cross(forward, self.up))
        # Recomputed rather than taken from `self.up`, which is only a hint: the true camera up
        # is perpendicular to both, and using the hint directly would skew every frame whose
        # look direction is not level.
        true_up = cross(right, forward)
        return right, true_up, forward

    def focal_pixels(self) -> float:
        half = math.radians(self.horizontal_fov_degrees) / 2.0
        return (self.width / 2.0) / math.tan(half)

    def to_camera_space(self, point: Vec3) -> Vec3:
        right, up, forward = self.basis()
        offset = sub(point, self.eye)
        return (dot(offset, right), dot(offset, up), dot(offset, forward))

    def project(self, camera_space: Vec3) -> tuple[float, float]:
        """Camera space to pixels. The caller has already clipped, so depth is positive."""
        focal = self.focal_pixels()
        x, y, z = camera_space
        return (self.width / 2.0 + focal * x / z, self.height / 2.0 - focal * y / z)


@dataclass(frozen=True, slots=True)
class Light:
    """One directional light, an optional fill, and an ambient term.

    `direction` points from the scene toward the light, which is the convention the shading
    expression below reads. Ambient exists so that a face turned fully away from the light is
    dark rather than black; a black face reads as a hole in the geometry, which is exactly the
    thing this product uses to mean "nothing was observed here".

    The fill is what makes interiors work. A single directional light leaves every surface facing
    away from it on ambient alone, and indoors that is the ceiling, which comes out darker than
    the floor. Real rooms are lit partly by what bounces off the floor, so the fill is a second,
    weaker direction rather than a fudge factor: pointing it downward reproduces the bounce, and
    a ceiling then reads as a ceiling instead of as a hole in the roof.
    """

    direction: Vec3
    ambient: float = 0.32
    fill_direction: Vec3 | None = None
    fill_weight: float = 0.0


def _clip_near(polygon: list[Vec3]) -> list[Vec3]:
    """Sutherland-Hodgman against the near plane, in camera space.

    Without this, a face straddling the lens plane projects through a division by a depth that
    crosses zero, and the polygon inverts across the whole image. It is the one clipping plane
    that matters: the rasteriser is happy to be handed coordinates outside the frame, but not
    coordinates that came from dividing by a negative depth.
    """
    clipped: list[Vec3] = []
    count = len(polygon)
    for index in range(count):
        current = polygon[index]
        following = polygon[(index + 1) % count]
        current_inside = current[2] >= _NEAR
        following_inside = following[2] >= _NEAR
        if current_inside:
            clipped.append(current)
        if current_inside != following_inside:
            span = following[2] - current[2]
            t = 0.0 if span == 0.0 else (_NEAR - current[2]) / span
            clipped.append(
                (
                    current[0] + t * (following[0] - current[0]),
                    current[1] + t * (following[1] - current[1]),
                    _NEAR,
                )
            )
    return clipped


def _shade(colour: tuple[int, int, int], normal: Vec3, light: Light) -> tuple[int, int, int]:
    lambert = max(0.0, dot(normal, light.direction))
    if light.fill_direction is not None and light.fill_weight > 0.0:
        fill = max(0.0, dot(normal, light.fill_direction))
        lambert = lambert * (1.0 - light.fill_weight) + fill * light.fill_weight
    factor = light.ambient + (1.0 - light.ambient) * lambert
    return tuple(  # type: ignore[return-value]
        min(255, max(0, round(channel * factor))) for channel in colour
    )


def _background(
    size: tuple[int, int],
    top: tuple[int, int, int],
    bottom: tuple[int, int, int],
) -> Image.Image:
    """A vertical gradient, built one pixel wide and stretched.

    Stretching a one-pixel column is exact for a vertical gradient and costs nothing, where
    drawing a thousand horizontal lines in Python costs a thousand round trips into the drawing
    layer for the same result.
    """
    width, height = size
    column = Image.new("RGB", (1, height))
    for y in range(height):
        t = y / max(1, height - 1)
        column.putpixel(
            (0, y),
            tuple(round(top[c] + (bottom[c] - top[c]) * t) for c in range(3)),  # type: ignore[arg-type]
        )
    return column.resize((width, height), Image.Resampling.BILINEAR)


def _grain(size: tuple[int, int], values: list[int]) -> Image.Image:
    """Deterministic film grain, from values the caller seeded.

    Pillow's own noise generator draws from an unseeded source, which would make two runs over
    the same corpus produce different bytes and therefore different content hashes. The whole
    point of this corpus is that ingesting it twice is a no-op, so the grain has to come from
    the same seeded stream as everything else.
    """
    width, height = size
    tile_width, tile_height = 160, 120
    tile = Image.new("L", (tile_width, tile_height))
    tile.putdata(values[: tile_width * tile_height])
    return tile.resize((width, height), Image.Resampling.BILINEAR).filter(
        ImageFilter.GaussianBlur(0.4)
    )


def render(
    faces: list[Face],
    camera: Camera,
    light: Light,
    *,
    sky_top: tuple[int, int, int],
    sky_bottom: tuple[int, int, int],
    grain_values: list[int] | None = None,
) -> Image.Image:
    """One frame. Far faces first, near faces last, nothing behind the lens.

    The supersample-then-reduce is the only concession to appearance in this file, and it is
    there because a hard-aliased edge compresses into JPEG ringing that is far more visible than
    the edge it came from. The geometry is unchanged: reducing an image does not move an edge,
    it only reports where the edge was with more precision.
    """
    scaled = Camera(
        eye=camera.eye,
        target=camera.target,
        horizontal_fov_degrees=camera.horizontal_fov_degrees,
        width=camera.width * _SUPERSAMPLE,
        height=camera.height * _SUPERSAMPLE,
        up=camera.up,
    )
    canvas = _background((scaled.width, scaled.height), sky_top, sky_bottom)
    draw = ImageDraw.Draw(canvas)

    drawable: list[tuple[float, list[tuple[float, float]], tuple[int, int, int]]] = []
    for face in faces:
        normal = face.normal()
        # Backface culling. A face whose outward normal points away from the eye is inside the
        # solid, and drawing it would paint the far wall of a box over its near wall.
        if dot(normal, sub(scaled.eye, face.vertices[0])) <= 0.0:
            continue
        camera_space = _clip_near([scaled.to_camera_space(vertex) for vertex in face.vertices])
        if len(camera_space) < 3:
            continue
        depth = sum(point[2] for point in camera_space) / len(camera_space)
        polygon = [scaled.project(point) for point in camera_space]
        drawable.append((depth, polygon, _shade(face.colour, normal, light)))

    # Far to near. Exact for this package's arrangements: every solid is convex and none
    # interpenetrate, so no two faces need to be split to be ordered correctly.
    drawable.sort(key=lambda item: item[0], reverse=True)
    for _depth, polygon, colour in drawable:
        draw.polygon(polygon, fill=colour)

    frame = canvas.resize((camera.width, camera.height), Image.Resampling.LANCZOS)
    if grain_values:
        grain = _grain((camera.width, camera.height), grain_values)
        frame = Image.blend(frame, Image.merge("RGB", (grain, grain, grain)), 0.045)
    return frame
