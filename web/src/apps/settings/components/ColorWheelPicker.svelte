<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    color: string; // e.g. "rgba(59, 130, 246, 1)" or "#3b82f6"
    onchange: (color: string) => void;
  }

  let { color, onchange }: Props = $props();

  let canvasRef = $state<HTMLCanvasElement | null>(null);
  let isDragging = $state(false);

  // Default HSL values
  let hue = $state(210);
  let saturation = $state(100);
  let lightness = $state(50);
  let alpha = $state(100);

  // Convert HSL to RGBA string
  const getRgbaString = (h: number, s: number, l: number, a: number): string => {
    // Standard HSL to RGB conversion
    const sPct = s / 100;
    const lPct = l / 100;
    const c = (1 - Math.abs(2 * lPct - 1)) * sPct;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = lPct - c / 2;

    let r = 0,
      g = 0,
      b = 0;
    if (0 <= h && h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (60 <= h && h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (120 <= h && h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (180 <= h && h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (240 <= h && h < 300) {
      r = x;
      g = 0;
      b = c;
    } else if (300 <= h && h < 360) {
      r = c;
      g = 0;
      b = x;
    }

    const rFinal = Math.round((r + m) * 255);
    const gFinal = Math.round((g + m) * 255);
    const bFinal = Math.round((b + m) * 255);
    const aFinal = Math.round((a / 100) * 100) / 100;

    return `rgba(${rFinal}, ${gFinal}, ${bFinal}, ${aFinal})`;
  };

  const drawWheel = () => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext('2d');
    if (!ctx) return;

    const width = canvasRef.width;
    const height = canvasRef.height;
    const radius = width / 2;

    ctx.clearRect(0, 0, width, height);

    // Draw hue spectrum circle
    for (let angle = 0; angle < 360; angle += 1) {
      const startAngle = ((angle - 1) * Math.PI) / 180;
      const endAngle = ((angle + 1) * Math.PI) / 180;

      ctx.beginPath();
      ctx.moveTo(radius, radius);
      ctx.arc(radius, radius, radius - 4, startAngle, endAngle);
      ctx.closePath();

      const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius - 4);
      gradient.addColorStop(0, `hsl(${angle}, 0%, 100%)`);
      gradient.addColorStop(1, `hsl(${angle}, 100%, 50%)`);

      ctx.fillStyle = gradient;
      ctx.fill();
    }
  };

  /**
   * Adopt the color we were handed, so the wheel opens on the one in use.
   *
   * `color` was declared in `Props`, destructured, and then never read — the sliders
   * always started at hue 210, full saturation, so the picker opened blue no matter what
   * the wallpaper actually was. A prop the parent passes and the child ignores is a
   * broken contract rather than an unused variable, which is why this reads it instead
   * of deleting it.
   *
   * Once only, at mount. Tracking `color` reactively would fight the user: every drag
   * emits through `onchange`, the parent stores it and passes it straight back, and the
   * incoming value would then re-derive the very state the drag is setting.
   */
  const adoptIncomingColor = () => {
    // Both forms, because the seed is `#rrggbb` and a color dragged off the wheel is
    // `rgba(...)` — and this component is on both ends of that round trip.
    let r: number, g: number, b: number;

    const hex = color.trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    } else {
      const match = color.match(/(\d+(?:\.\d+)?)/g);
      if (!match || match.length < 3) return;
      [r, g, b] = match.slice(0, 3).map(Number);
      if (match.length >= 4) alpha = Math.round(Math.min(1, Number(match[3])) * 100);
    }
    if ([r, g, b].some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return;

    const [rf, gf, bf] = [r / 255, g / 255, b / 255];
    const max = Math.max(rf, gf, bf);
    const min = Math.min(rf, gf, bf);
    const delta = max - min;

    lightness = Math.round(((max + min) / 2) * 100);
    saturation = delta === 0 ? 0 : Math.round((delta / (1 - Math.abs(max + min - 1))) * 100);

    if (delta === 0) {
      hue = 0;
    } else if (max === rf) {
      hue = Math.round(60 * (((gf - bf) / delta + 6) % 6));
    } else if (max === gf) {
      hue = Math.round(60 * ((bf - rf) / delta + 2));
    } else {
      hue = Math.round(60 * ((rf - gf) / delta + 4));
    }
  };

  onMount(() => {
    adoptIncomingColor();
    drawWheel();
  });

  const updateColorFromPointer = (e: MouseEvent | TouchEvent) => {
    if (!canvasRef) return;
    const rect = canvasRef.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;

    const dist = Math.sqrt(x * x + y * y);
    const maxRadius = rect.width / 2;

    // Angle in degrees (0..360)
    let angle = (Math.atan2(y, x) * 180) / Math.PI;
    if (angle < 0) angle += 360;

    hue = Math.round(angle);
    saturation = Math.min(100, Math.round((dist / maxRadius) * 100));

    const newRgba = getRgbaString(hue, saturation, lightness, alpha);
    onchange(newRgba);
  };

  const handlePointerDown = (e: PointerEvent | MouseEvent | TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;

    if ('pointerId' in e && canvasRef) {
      try {
        canvasRef.setPointerCapture(e.pointerId);
      } catch {}
    }

    updateColorFromPointer(e);
  };

  const handlePointerMove = (e: MouseEvent | TouchEvent) => {
    if (isDragging) {
      e.preventDefault();
      e.stopPropagation();
      updateColorFromPointer(e);
    }
  };

  const handlePointerUp = (e?: PointerEvent | MouseEvent | TouchEvent) => {
    if (isDragging && e && 'pointerId' in e && canvasRef) {
      try {
        canvasRef.releasePointerCapture(e.pointerId);
      } catch {}
    }
    isDragging = false;
  };
</script>

<svelte:window onpointermove={handlePointerMove} onpointerup={handlePointerUp} />

<div class="flex flex-col items-center gap-4">
  <!-- Wheel Canvas -->
  <div class="relative flex items-center justify-center">
    <canvas
      bind:this={canvasRef}
      width={180}
      height={180}
      onpointerdown={handlePointerDown}
      class="border-outline-variant cursor-crosshair touch-none rounded-full border shadow-md"
    ></canvas>
  </div>

  <!-- Lightness & Transparency Sliders -->
  <div class="text-on-surface w-full space-y-3 px-2 text-xs">
    <div class="flex flex-col gap-1">
      <div class="flex justify-between">
        <span class="font-medium">Lightness</span>
        <span class="text-on-surface-variant font-mono">{lightness}%</span>
      </div>
      <input
        type="range"
        min="10"
        max="90"
        bind:value={lightness}
        oninput={() => onchange(getRgbaString(hue, saturation, lightness, alpha))}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-blue-500"
      />
    </div>

    <div class="flex flex-col gap-1">
      <div class="flex justify-between">
        <span class="font-medium">Opacity / Alpha</span>
        <span class="text-on-surface-variant font-mono">{alpha}%</span>
      </div>
      <input
        type="range"
        min="10"
        max="100"
        bind:value={alpha}
        oninput={() => onchange(getRgbaString(hue, saturation, lightness, alpha))}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-blue-500"
      />
    </div>
  </div>
</div>
