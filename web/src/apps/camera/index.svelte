<script lang="ts">
  import { asDataUri, cropImageToAspect, cropViewportToCanvas, LANDSCAPE_ASPECT } from './capture';
  import {
    useCamera,
    useMedia,
    useKeybinds,
    useNavigation,
    useAppAction,
    usePhoneNotification,
    useTimer,
    onAppForeground,
    CloseIcon,
    FlipCameraIcon,
    PhotoIcon,
    isBrowser,
    type AppProps
  } from '@gphone/sdk';
  import { useNuiBridge, useCaptureZoomBoost } from '@gphone/sdk/core';

  const { isTakingPhoto, isPreviewingPhoto } = useCamera();
  const { capturePhoto, media } = useMedia();
  const { openApp } = useNavigation();
  const { run } = useAppAction('camera');
  const { toast } = usePhoneNotification();
  const { after } = useTimer();
  import { sampleAvatars } from './mockViewfinder';
  import { onDestroy, tick } from 'svelte';

  let { onback }: AppProps = $props();

  const { fetchNui, useNuiEvent } = useNuiBridge();
  const captureZoomBoost = useCaptureZoomBoost();

  let cameraMode = $state<'PHOTO' | 'VIDEO' | 'LANDSCAPE'>('PHOTO');

  /**
   * LANDSCAPE reframes the camera, not the phone.
   *
   * A real phone shoots landscape by turning over; this one cannot — the screen is a fixed
   * 400x850 and an app must never try to be responsive (AGENTS.md §5). Rotating the frame
   * with a transform would leave the DOM box model portrait underneath it, so every control
   * would be hit-tested where it is *not* drawn, and the phone would still have to be
   * un-rotated on close. So the camera keeps its portrait body and narrows what it is
   * pointing at: a 16:9 frame across the middle of the viewfinder, with the world above and
   * below it matted off.
   *
   * The frame is not decoration. `captureRef` below is the element the photo is cropped to,
   * so what the mattes leave visible is exactly what gets saved.
   */
  const isLandscape = $derived(cameraMode === 'LANDSCAPE');
  let isFrontCamera = $state(false);
  let isFlashing = $state(false);
  let isThumbnailBouncing = $state(false);

  let mockPhotoIndex = $state(1);
  let currentViewfinderImage = $derived(sampleAvatars[mockPhotoIndex % sampleAvatars.length]);

  let containerRef = $state<HTMLElement | null>(null);
  let captureRef = $state<HTMLElement | null>(null);
  let thumbnailRef = $state<HTMLElement | null>(null);

  /**
   * The just-captured photo, animating from the viewfinder down into the gallery
   * thumbnail. Null when nothing is in flight.
   *
   * `style` carries the transform that moves it; it is applied one frame after mount so
   * the browser has an initial position to animate away from.
   */
  let flyingPhoto = $state<{ src: string; box: string; style: string } | null>(null);
  let cancelFly: (() => void) | undefined;

  const FLY_MS = 400;

  /**
   * Send the captured frame to the thumbnail.
   *
   * Measured rather than hard-coded: the thumbnail sits in a flex row whose position
   * depends on whether the flip control is showing, so a fixed offset would drift.
   */
  const flyToThumbnail = (src: string) => {
    const container = containerRef?.getBoundingClientRect();
    // The framed region rather than the whole viewfinder: it is what was photographed,
    // so in LANDSCAPE the frame that flies to the thumbnail is the shape of the photo
    // inside it. In PHOTO the two boxes are the same, so nothing changes.
    const from = captureRef?.getBoundingClientRect();
    const to = thumbnailRef?.getBoundingClientRect();
    if (!container || !from || !to || from.width === 0) {
      // No geometry to animate with (jsdom, or a hidden pane). Skip straight to the
      // bounce rather than leaving a stuck overlay.
      bounceThumbnail();
      return;
    }

    // Positioned against the outer container rather than the viewfinder: the viewfinder
    // is `overflow-hidden`, so a child animating down towards the controls would be
    // clipped at its edge and never arrive.
    const box =
      `left: ${from.left - container.left}px; top: ${from.top - container.top}px; ` +
      `width: ${from.width}px; height: ${from.height}px;`;

    const scale = to.width / from.width;
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);

    flyingPhoto = { src, box, style: 'transform: none; opacity: 1;' };

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!flyingPhoto) return;
        flyingPhoto = {
          src,
          box,
          style: `transform: translate(${dx}px, ${dy}px) scale(${scale}); opacity: 0.85;`
        };
      });
    });

    cancelFly?.();
    cancelFly = after(FLY_MS, () => {
      flyingPhoto = null;
      bounceThumbnail();
    });
  };

  const bounceThumbnail = () => {
    isThumbnailBouncing = true;
    after(600, () => {
      isThumbnailBouncing = false;
    });
  };

  const { onKeybind, bindings } = useKeybinds();

  /** `' '` renders as nothing, and a bare letter reads better capitalised. */
  const keyLabel = (key: string) =>
    key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;

  // The thumbnail shows the newest photo, which may have arrived from anywhere.
  onAppForeground('camera', () => {
    void media.load();
  });

  onDestroy(() => {
    isPreviewingPhoto.set(false);
  });

  // The client reports whether the scripted camera is up. It answers `supported: false`
  // only if the app is somehow open without it, in which case hiding the control beats
  // offering one that does nothing.
  let canFlipCamera = $state(true);

  const toggleFlipCamera = async () => {
    const next = !isFrontCamera;
    let supported = true;
    const flipped = await run(
      async () => {
        const res = await fetchNui<{ supported?: boolean }>('flipCamera', {
          isFrontCamera: next
        });
        supported = res?.supported !== false;
      },
      { error: 'Could not switch camera' }
    );
    if (!flipped) return;

    if (!supported) canFlipCamera = false;
    else isFrontCamera = next;
  };

  /**
   * Cut the browser stand-in image down to the landscape frame.
   *
   * Falls back to the uncropped image on anything that does not work — an engine that
   * reports no intrinsic size for the mock's SVG data URI, a canvas it will not read back.
   * A slightly wrong dev photo beats a shutter press that saves nothing.
   */
  const framedMockPhoto = async (src: string): Promise<string> => {
    try {
      const img = new Image();
      img.src = src;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        setTimeout(() => reject(new Error('Mock viewfinder load timeout')), 1000);
      });
      return cropImageToAspect(img, LANDSCAPE_ASPECT) ?? src;
    } catch (err) {
      console.warn('Landscape mock crop fallback used:', err);
      return src;
    }
  };

  const takePhoto = async () => {
    isTakingPhoto.set(true);

    // A brief pulse, not a white screen. This used to hold solid white for 180ms, which
    // was tolerable over the old opaque black panel and is jarring now that the
    // viewfinder shows the live world. The overlay stays mounted and fades, so the
    // ramp down is visible instead of the element simply vanishing.
    isFlashing = true;
    after(60, () => {
      isFlashing = false;
    });

    // Briefly draw the phone at max zoom, under cover of the flash above, so
    // `screencapture` grabs more real pixels for the crop below instead of a small
    // capture getting stretched up afterwards. Only worth doing for a real capture —
    // the browser mock ignores geometry entirely.
    const boostedZoom = !isBrowser();
    if (boostedZoom) {
      captureZoomBoost.set(true);
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    // The region the photo is cut from, measured after the zoom boost above and before
    // the chrome is hidden. This is the framing element itself, not the whole phone, so a
    // LANDSCAPE frame produces a genuinely wider-than-tall crop — `computeCropGeometry`
    // already caps whichever edge is longer, so no further maths is needed here.
    const rect = captureRef?.getBoundingClientRect();

    // The chrome fades out over `duration-short` (100ms), and the screenshot is a crop
    // of this exact region — so the capture has to wait for the fade to finish or the
    // shutter bar is still half-visible in the photo.
    const CHROME_FADE_MS = 100;

    after(CHROME_FADE_MS + 30, async () => {
      try {
        let capturedImage: string;

        if (isBrowser()) {
          // In browser mode, capture the EXACT image currently shown on the big viewfinder screen!
          // There is no world behind the viewfinder here and the stand-in is square, so a
          // LANDSCAPE shot has to be cut to the frame explicitly — otherwise the browser
          // viewfinder frames 16:9 and saves a square, which is the one failure this mode
          // cannot have.
          capturedImage = isLandscape
            ? await framedMockPhoto(currentViewfinderImage)
            : currentViewfinderImage;
          // Advance viewfinder screen to the next scene for the next photo
          mockPhotoIndex++;
        } else {
          const base64Data = await fetchNui<string>('takePhoto');
          capturedImage = base64Data;

          // The screenshot is already taken — the boosted zoom did its job the moment
          // `takePhoto` resolved. Shrinking back now, rather than waiting for the crop,
          // save and gallery-refresh below to finish, keeps the oversized phone on
          // screen for as short a window as possible instead of however long that whole
          // round trip happens to take.
          if (boostedZoom) captureZoomBoost.set(false);

          if (
            !base64Data.startsWith('http') &&
            !base64Data.startsWith('https') &&
            rect &&
            base64Data
          ) {
            try {
              const img = new Image();
              img.crossOrigin = 'Anonymous';
              img.src = asDataUri(base64Data);

              await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                setTimeout(() => reject(new Error('Image load timeout')), 3000);
              });

              const cropped = cropViewportToCanvas(
                img,
                {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height
                },
                window.innerWidth,
                window.innerHeight
              );
              if (cropped) {
                capturedImage = cropped;
              }
            } catch (err) {
              console.warn('Canvas crop fallback used:', err);
              capturedImage = base64Data;
            }
          }
        }

        if (!capturedImage || capturedImage === 'data:,' || capturedImage.length < 30) {
          capturedImage = sampleAvatars[0];
        }

        // Directly save captured photo to gallery
        await capturePhoto(capturedImage);
        await media.load();

        // Send the frame down into the thumbnail, then bounce it on arrival.
        flyToThumbnail(capturedImage);
      } catch (err) {
        // Reported rather than swallowed: a shutter press that saves nothing looked
        // identical to one that worked, because the viewfinder is unchanged either way.
        console.error('Failed to take photo', err);
        toast.show({ type: 'error', app: 'camera', message: 'Could not save that photo' });
      } finally {
        if (boostedZoom) captureZoomBoost.set(false);
        isTakingPhoto.set(false);
      }
    });
  };

  const shoot = () => {
    if ($isTakingPhoto || $isPreviewingPhoto) return;
    void takePhoto();
  };

  // Claimed only while the camera is mounted, so Enter is the shutter here and stays
  // free for whatever else wants it elsewhere.
  // `shutter` carries `when: 'app:camera'`, so it is already scoped at the action. Naming
  // the owner here too costs nothing and keeps the claim correct if that ever changes.
  onKeybind('shutter', shoot, 'camera');

  // Left click, relayed by the client. Aiming leaves no NUI cursor, so the click never
  // reaches the page and has to be read from the game control instead.
  useNuiEvent('cameraShutter', shoot);
</script>

<!-- No opaque background in game: PhoneFrame goes transparent while the camera is open
     so the world renders through the viewfinder, and a bg-black here would paint over
     it — every capture came out black. The browser mock needs a backdrop, so it keeps
     one. -->
<div
  bind:this={containerRef}
  class="text-on-surface rounded-frame-inner relative flex h-full flex-col overflow-hidden select-none"
  class:bg-black={isBrowser()}
>
  <!-- Live Viewfinder / Camera View -->
  <div
    class="rounded-frame-inner relative flex flex-1 flex-col justify-between overflow-hidden p-4"
    class:bg-black={isBrowser()}
  >
    <!-- Mock Browser Viewfinder Background Image (Displayed in browser mode when FiveM 3D world is not running) -->
    {#if isBrowser()}
      <img
        src={currentViewfinderImage}
        alt="Camera Viewfinder Mock"
        class="duration-medium ease-standard pointer-events-none absolute inset-0 h-full w-full object-cover opacity-85 transition-opacity"
      />
    {/if}

    <!-- Shutter flash. Always mounted so the fade-out actually renders: toggling with
         {#if} removed the element outright, which is why the old flash ended as an
         abrupt cut rather than a pulse. Peaks below full white — over a live viewfinder
         a solid #fff reads as a bug rather than a shutter. -->
    <div
      class="ease-standard pointer-events-none absolute inset-0 z-20 bg-white transition-opacity"
      class:opacity-0={!isFlashing}
      class:opacity-80={isFlashing}
      class:duration-short={isFlashing}
      class:duration-medium={!isFlashing}
    ></div>

    <!-- Keyboard hint. The mouse aims rather than pointing while the camera is open, so
         the on-screen controls cannot be clicked and these keys are the only way in. -->
    {#if !isBrowser()}
      <div
        class="text-on-surface text-label-small duration-short ease-standard pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center gap-2 transition-opacity"
        class:opacity-0={$isTakingPhoto}
      >
        {#each [['shutter', 'Shoot'], ['back', 'Close'], ['freelook', 'Cursor']] as [id, label] (id)}
          <span class="rounded bg-black/50 px-1.5 py-0.5 backdrop-blur-sm">
            <span class="text-on-surface font-mono">{keyLabel($bindings[id])}</span>
            {label}
          </span>
        {/each}
      </div>
    {/if}

    <!-- Top Controls -->
    <div
      class="duration-short ease-standard z-10 flex items-center justify-between pt-1 transition-opacity"
      class:opacity-0={$isTakingPhoto}
    >
      <button
        onclick={onback}
        class="text-on-surface shadow-elevation-3 duration-short ease-standard cursor-pointer rounded-full border border-white/10 bg-black/40 p-2.5 backdrop-blur-md transition-colors hover:bg-black/60"
        aria-label="Go back"
      >
        <CloseIcon class="size-icon-md" />
      </button>
    </div>

    <!-- The frame, and the crop. Every photo is cut to `captureRef`'s own box rather than
         to the whole phone, so the two cannot disagree: in PHOTO it fills the viewfinder,
         in LANDSCAPE it is a 16:9 band across the middle with the world above and below it
         matted off. A viewfinder that frames one thing and saves another would be worse
         than having no landscape mode, so the framing element *is* the crop rect.

         The mattes sit outside that box and so never reach the photo, which is why they
         stay lit through the capture while the chrome fades. -->
    <div class="pointer-events-none absolute inset-0 flex flex-col justify-center">
      {#if isLandscape}
        <div class="min-h-0 flex-1 bg-black opacity-60"></div>
      {/if}

      <div
        bind:this={captureRef}
        data-testid="camera-capture-region"
        class="relative w-full"
        class:h-full={!isLandscape}
        class:aspect-video={isLandscape}
        class:shrink-0={isLandscape}
      >
        <!-- Grid Overlay Guide. Inside the frame, so it rules off what is actually being
             composed. The visible opacity is a directive rather than a second static
             class: two `opacity-*` classes on one element is not a fade, it is whichever
             rule sorts later in `app-utilities.css` winning outright — `.opacity-20` sorts
             after `.opacity-0`, so the grid never dimmed for the capture and every photo
             had faint white rules baked into it. -->
        <div
          class="duration-short ease-standard absolute inset-0 grid grid-cols-3 grid-rows-3 transition-opacity"
          class:opacity-20={!$isTakingPhoto}
          class:opacity-0={$isTakingPhoto}
        >
          <div class="border-r border-b border-white"></div>
          <div class="border-r border-b border-white"></div>
          <div class="border-b border-white"></div>
          <div class="border-r border-b border-white"></div>
          <div class="border-r border-b border-white"></div>
          <div class="border-b border-white"></div>
          <div class="border-r border-white"></div>
          <div class="border-r border-white"></div>
          <div></div>
        </div>
      </div>

      {#if isLandscape}
        <div class="min-h-0 flex-1 bg-black opacity-60"></div>
      {/if}
    </div>

    <!-- Bottom Controls. Hidden during capture along with the rest of the chrome: the
         in-game photo is a crop of this exact region, so anything still on screen ends
         up inside the picture. -->
    <div
      class="bg-surface-container border-outline-variant text-on-surface rounded-b-frame-inner shadow-elevation-5 duration-short ease-standard relative z-10 mx-[-1rem] mb-[-1rem] flex transform-gpu flex-col items-center gap-4 overflow-hidden border-t px-4 pt-4 pb-10 backdrop-blur-lg transition-opacity"
      class:opacity-0={$isTakingPhoto}
    >
      <!-- Mode Toggle Buttons. VIDEO is still disabled — there is no recording pipeline
           behind it (MICA-80), and a mode that silently does nothing reads as broken
           rather than unfinished. LANDSCAPE is live as of MICA-79: it reframes the
           capture region above, which is the box the photo is cut from. -->
      <div class="flex items-center gap-4">
        {#each ['PHOTO', 'VIDEO', 'LANDSCAPE'] as mode (mode)}
          <button
            type="button"
            disabled={mode === 'VIDEO'}
            title={mode === 'VIDEO' ? 'Coming soon' : undefined}
            onclick={() => (cameraMode = mode as 'PHOTO' | 'VIDEO' | 'LANDSCAPE')}
            class="text-body-small duration-medium ease-standard rounded-full px-3.5 py-1 tracking-wider uppercase transition-all {cameraMode ===
            mode
              ? 'shadow-elevation-1 scale-105 border border-yellow-400/40 bg-black/60 text-yellow-400'
              : mode === 'VIDEO'
                ? 'text-on-surface-variant cursor-not-allowed opacity-40'
                : 'text-on-surface hover:text-on-surface cursor-pointer'}"
          >
            {mode}
          </button>
        {/each}
      </div>

      <!-- Shutter Row: Gallery Preview (Left) | Shutter Button (Center) | Flip Camera (Right) -->
      <div class="flex w-full items-center justify-between px-6 pt-1">
        <!-- Left: Gallery Preview Thumbnail (Clicking opens directly to that photo in Media app) -->
        <button
          type="button"
          bind:this={thumbnailRef}
          onclick={() => {
            if ($media.length > 0) {
              openApp('media', {
                initialPhoto: $media[0]
              });
            } else {
              openApp('media');
            }
          }}
          class="group shadow-elevation-3 duration-medium ease-standard flex h-12 w-12 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-white/30 bg-black/40 transition-all {isThumbnailBouncing
            ? 'shadow-elevation-4 scale-110 border-yellow-400 ring-2 shadow-yellow-400/30 ring-yellow-400/60'
            : 'hover:scale-105'}"
          aria-label="Open Media Gallery"
        >
          {#if $media.length > 0}
            <img
              src={$media[0].data}
              alt="Recent capture"
              class="duration-short ease-standard h-full w-full object-cover transition-opacity group-hover:opacity-90"
            />
          {:else}
            <PhotoIcon class="text-on-surface-variant size-icon-lg" />
          {/if}
        </button>

        <!-- Center: Shutter Button -->
        <button
          onclick={takePhoto}
          class="shadow-elevation-5 duration-short ease-standard flex h-20 w-20 cursor-pointer items-center justify-center rounded-full border-4 border-white p-1 transition-transform hover:scale-105 active:scale-95"
          aria-label="Take photo"
        >
          <div
            class="duration-medium ease-standard h-full w-full rounded-full transition-all {cameraMode ===
            'VIDEO'
              ? 'bg-error scale-75 rounded-md'
              : 'bg-white'}"
          ></div>
        </button>

        <!-- Right: Flip Camera Button. Kept in the layout as a spacer when unsupported,
             so removing it does not re-center the shutter. -->
        {#if canFlipCamera}
          <button
            type="button"
            onclick={toggleFlipCamera}
            class="text-on-surface shadow-elevation-3 duration-short ease-standard flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-white/20 backdrop-blur-md transition-transform hover:bg-white/30 active:rotate-180"
            aria-label="Flip camera"
          >
            <FlipCameraIcon class="size-icon-lg" />
          </button>
        {:else}
          <div class="h-12 w-12" aria-hidden="true"></div>
        {/if}
      </div>
    </div>
  </div>

  <!-- The captured frame travelling to the gallery thumbnail, matted in white so it
       reads as a photo leaving the camera rather than the viewfinder sliding away.
       A child of the outer container so it can cross into the controls strip. -->
  {#if flyingPhoto}
    <div
      class="shadow-elevation-5 pointer-events-none absolute z-30 origin-center rounded-lg bg-white p-1.5"
      style="transition: transform {FLY_MS}ms var(--ease-standard), opacity {FLY_MS}ms var(--ease-standard); {flyingPhoto.box} {flyingPhoto.style}"
    >
      <img src={flyingPhoto.src} alt="" class="h-full w-full rounded-xl object-cover" />
    </div>
  {/if}
</div>
