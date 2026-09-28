"""Generate the app backdrop: a soft golden-hour desert scene (procedural, no stock imagery).

    python scripts/make_backdrop.py  ->  public/backdrop.jpg
"""
import numpy as np
from PIL import Image, ImageFilter

W, H = 2560, 1600
rng = np.random.default_rng(7)
y = np.linspace(0, 1, H)[:, None]
x = np.linspace(0, 1, W)[None, :]


def mix(a, b, t):
    a, b = np.array(a, float), np.array(b, float)
    t = np.clip(t, 0, 1)[..., None]
    return a * (1 - t) + b * t


# sky: warm haze, brighter toward the horizon, with a low sun glow
horizon = 0.56
sky = mix((196, 160, 122), (246, 228, 196), (y / horizon) ** 1.6)
sky = np.broadcast_to(sky, (H, W, 3)).copy()
sun_x, sun_y = 0.64, 0.50
d = np.sqrt(((x - sun_x) * 1.6) ** 2 + (y - sun_y) ** 2)
glow = np.exp(-(d / 0.26) ** 2)[..., None]
sky = sky * (1 - 0.7 * glow) + np.array([255, 238, 196]) * 0.7 * glow
halo = np.exp(-(d / 0.6) ** 2)[..., None]
sky = sky * (1 - 0.25 * halo) + np.array([250, 214, 160]) * 0.25 * halo
img = sky


def dune_layer(img, base, amp, freqs, phase, top_col, bot_col, shadow, haze):
    xs = np.linspace(0, 1, W)
    crest = base + sum(a * np.sin(2 * np.pi * f * xs + p) for a, f, p in zip(amp, freqs, phase))
    mask = (np.arange(H)[:, None] / H) > crest[None, :]
    depth = np.clip((np.arange(H)[:, None] / H - crest[None, :]) / 0.25, 0, 1)
    col = mix(top_col, bot_col, depth)
    # light from the sun side, shadow on the far slopes
    slope = np.gradient(crest)[None, :] * W
    lit = np.clip(0.5 + slope * shadow, 0, 1)[..., None]
    col = col * (0.82 + 0.3 * lit)
    col = col * (1 - haze) + np.array([240, 220, 188]) * haze
    img[mask] = col[mask]
    return img


img = dune_layer(img, 0.60, [0.018, 0.010, 0.006], [1.1, 2.7, 5.3], [0.4, 1.9, 0.2], (232, 204, 164), (214, 182, 138), 0.9, 0.45)
img = dune_layer(img, 0.68, [0.030, 0.014, 0.007], [0.8, 2.1, 4.4], [2.2, 0.3, 1.1], (226, 190, 140), (196, 158, 108), 1.2, 0.25)
img = dune_layer(img, 0.79, [0.045, 0.020, 0.009], [0.6, 1.7, 3.9], [1.1, 2.6, 0.7], (214, 172, 118), (170, 128, 82), 1.5, 0.08)
img = dune_layer(img, 0.90, [0.050, 0.020, 0.010], [0.5, 1.3, 3.1], [3.0, 0.9, 2.1], (196, 152, 98), (150, 108, 66), 1.8, 0.0)

# fine wind ripples in the foreground
yy = np.arange(H)[:, None] / H
rip = np.sin(2 * np.pi * (x * 90 + yy * 30 + 0.8 * np.sin(2 * np.pi * x * 3))) * np.clip((yy - 0.8) / 0.2, 0, 1)
img = img * (1 + 0.012 * rip[..., None])

# vignette + grain
vig = 1 - 0.28 * np.clip(np.sqrt(((x - 0.5) * 1.1) ** 2 + ((y - 0.48) * 1.3) ** 2) - 0.25, 0, 1) ** 1.2
img = img * vig[..., None]
out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3.5))
arr = np.asarray(out).astype(float) + rng.normal(0, 3.2, (H, W, 1))
Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save("public/backdrop.jpg", quality=80, optimize=True, progressive=True)
print("public/backdrop.jpg written")
