<script lang="ts">
  import { asDataUri, encodeCrop } from './capture';
  import {
    useCamera,
    useKeybinds,
    useNavigation,
    useNuiBridge,
    onAppMount,
    CloseIcon,
    FlipCameraIcon,
    PhotoIcon,
    isBrowser
  } from '@gphone/sdk';

  const { capturePhoto, photosStore, isTakingPhoto, isPreviewingPhoto } = useCamera();
  const { openApp } = useNavigation();
  import { sampleAvatars } from './mockViewfinder';
  import { onDestroy } from 'svelte';

  let { onback } = $props<{ onback: () => void }>();

  const { fetchNui, useNuiEvent } = useNuiBridge();

  let cameraMode = $state<'PHOTO' | 'VIDEO' | 'LANDSCAPE'>('PHOTO');
  let isFrontCamera = $state(false);
  let isFlashing = $state(false);
  let isThumbnailBouncing = $state(false);

  let mockPhotoIndex = $state(1);
  let currentViewfinderImage = $derived(sampleAvatars[mockPhotoIndex % sampleAvatars.length]);

  let containerRef = $state<HTMLElement | null>(null);
  let viewfinderRef = $state<HTMLElement | null>(null);
  let thumbnailRef = $state<HTMLElement | null>(null);

  /**
   * The just-captured photo, animating from the viewfinder down into the gallery
   * thumbnail. Null when nothing is in flight.
   *
   * `style` carries the transform that moves it; it is applied one frame after mount so
   * the browser has an initial position to animate away from.
   */
  let flyingPhoto = $state<{ src: string; box: string; style: string } | null>(null);
  let flyTimer: ReturnType<typeof setTimeout> | undefined;

  const FLY_MS = 480;

  /**
   * Send the captured frame to the thumbnail.
   *
   * Measured rather than hard-coded: the thumbnail sits in a flex row whose position
   * depends on whether the flip control is showing, so a fixed offset would drift.
   */
  const flyToThumbnail = (src: string) => {
    const container = containerRef?.getBoundingClientRect();
    const from = viewfinderRef?.getBoundingClientRect();
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

    clearTimeout(flyTimer);
    flyTimer = setTimeout(() => {
      flyingPhoto = null;
      bounceThumbnail();
    }, FLY_MS);
  };

  const bounceThumbnail = () => {
    isThumbnailBouncing = true;
    setTimeout(() => {
      isThumbnailBouncing = false;
    }, 600);
  };

  const { onKeybind, bindings } = useKeybinds();

  /** `' '` renders as nothing, and a bare letter reads better capitalised. */
  const keyLabel = (key: string) =>
    key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;

  onAppMount(() => {
    photosStore.load();
  });

  onDestroy(() => {
    isPreviewingPhoto.set(false);
    clearTimeout(flyTimer);
  });

  // The client reports whether the scripted camera is up. It answers `supported: false`
  // only if the app is somehow open without it, in which case hiding the control beats
  // offering one that does nothing.
  let canFlipCamera = $state(true);

  const toggleFlipCamera = async () => {
    const next = !isFrontCamera;
    try {
      const res = await fetchNui<{ supported?: boolean }>('flipCamera', {
        isFrontCamera: next
      });
      if (res?.supported === false) {
        canFlipCamera = false;
        return;
      }
      isFrontCamera = next;
    } catch (e) {
      console.error('Failed to flip camera', e);
    }
  };

  const takePhoto = async () => {
    isTakingPhoto.set(true);

    // Get the phone dimensions from the container before hiding it
    const rect = containerRef?.getBoundingClientRect();

    // A brief pulse, not a white screen. This used to hold solid white for 180ms, which
    // was tolerable over the old opaque black panel and is jarring now that the
    // viewfinder shows the live world. The overlay stays mounted and fades, so the
    // ramp down is visible instead of the element simply vanishing.
    isFlashing = true;
    setTimeout(() => {
      isFlashing = false;
    }, 60);

    // The chrome fades out over `duration-75`, and the screenshot is a crop of this
    // exact region — so the capture has to wait for the fade to finish or the shutter
    // bar is still half-visible in the photo. Was 50ms against a 75ms fade.
    const CHROME_FADE_MS = 75;

    setTimeout(async () => {
      try {
        let capturedImage: string;

        if (isBrowser()) {
          // In browser mode, capture the EXACT image currently shown on the big viewfinder screen!
          capturedImage = currentViewfinderImage;
          // Advance viewfinder screen to the next scene for the next photo
          mockPhotoIndex++;
        } else {
          const base64Data = await fetchNui<string>('takePhoto');
          capturedImage = base64Data;

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

              const scaleX = img.naturalWidth / window.innerWidth;
              const scaleY = img.naturalHeight / window.innerHeight;

              const physX = Math.round(rect.left * scaleX);
              const physY = Math.round(rect.top * scaleY);
              const physWidth = Math.round(rect.width * scaleX);
              const physHeight = Math.round(rect.height * scaleY);

              if (physWidth > 10 && physHeight > 10) {
                const canvas = document.createElement('canvas');
                canvas.width = physWidth;
                canvas.height = physHeight;

                const ctx = canvas.getContext('2d');
                if (ctx) {
                  // The crop is 1:1 with the source, so no resampling happens and
                  // smoothing would only soften it.
                  ctx.imageSmoothingEnabled = false;
                  ctx.drawImage(
                    img,
                    physX,
                    physY,
                    physWidth,
                    physHeight,
                    0,
                    0,
                    physWidth,
                    physHeight
                  );
                  const cropped = encodeCrop(canvas);
                  if (cropped && cropped.length > 30 && cropped !== 'data:,') {
                    capturedImage = cropped;
                  }
                }
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
        await photosStore.load();

        // Send the frame down into the thumbnail, then bounce it on arrival.
        flyToThumbnail(capturedImage);
      } catch (err) {
        console.error('Failed to take photo', err);
      } finally {
        isTakingPhoto.set(false);
      }
    }, CHROME_FADE_MS + 30);
  };

  const shoot = () => {
    if ($isTakingPhoto || $isPreviewingPhoto) return;
    void takePhoto();
  };

  // Claimed only while the camera is mounted, so Enter is the shutter here and stays
  // free for whatever else wants it elsewhere.
  onKeybind('shutter', shoot);

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
  class="relative flex h-full flex-col overflow-hidden rounded-[3rem] text-white select-none"
  class:bg-black={isBrowser()}
>
  <!-- Live Viewfinder / Camera View -->
  <div
    bind:this={viewfinderRef}
    class="relative flex flex-1 flex-col justify-between overflow-hidden rounded-[3rem] p-4"
    class:bg-black={isBrowser()}
  >
    <!-- Mock Browser Viewfinder Background Image (Displayed in browser mode when FiveM 3D world is not running) -->
    {#if isBrowser()}
      <img
        src={currentViewfinderImage}
        alt="Camera Viewfinder Mock"
        class="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-85 transition-opacity duration-300"
      />
    {/if}

    <!-- Shutter flash. Always mounted so the fade-out actually renders: toggling with
         {#if} removed the element outright, which is why the old flash ended as an
         abrupt cut rather than a pulse. Peaks below full white — over a live viewfinder
         a solid #fff reads as a bug rather than a shutter. -->
    <div
      class="pointer-events-none absolute inset-0 z-20 bg-white transition-opacity ease-out"
      class:opacity-0={!isFlashing}
      class:opacity-80={isFlashing}
      class:duration-75={isFlashing}
      class:duration-300={!isFlashing}
    ></div>

    <!-- Keyboard hint. The mouse aims rather than pointing while the camera is open, so
         the on-screen controls cannot be clicked and these keys are the only way in. -->
    {#if !isBrowser()}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center gap-2 text-[10px] text-white/70 transition-opacity duration-75"
        class:opacity-0={$isTakingPhoto}
      >
        {#each [['shutter', 'Shoot'], ['back', 'Close'], ['freelook', 'Cursor']] as [id, label] (id)}
          <span class="rounded bg-black/50 px-1.5 py-0.5 backdrop-blur-sm">
            <span class="font-mono text-white">{keyLabel($bindings[id])}</span>
            {label}
          </span>
        {/each}
      </div>
    {/if}

    <!-- Top Controls -->
    <div
      class="z-10 flex items-center justify-between pt-1 transition-opacity duration-75"
      class:opacity-0={$isTakingPhoto}
    >
      <button
        onclick={onback}
        class="cursor-pointer rounded-full border border-white/10 bg-black/40 p-2.5 text-white shadow-lg backdrop-blur-md transition-colors hover:bg-black/60"
        aria-label="Go back"
      >
        <CloseIcon class="h-5 w-5" />
      </button>
    </div>

    <!-- Grid Overlay Guide -->
    <div
      class="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-20 transition-opacity duration-75"
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

    <!-- Bottom Controls. Hidden during capture along with the rest of the chrome: the
         in-game photo is a crop of this exact region, so anything still on screen ends
         up inside the picture. -->
    <div
      class="relative z-10 mx-[-1rem] mb-[-1rem] flex transform-gpu flex-col items-center gap-4 overflow-hidden rounded-b-[3rem] bg-black/90 px-4 pt-4 pb-10 text-white shadow-2xl backdrop-blur-lg transition-opacity duration-75"
      class:opacity-0={$isTakingPhoto}
    >
      <!-- Mode Toggle Buttons -->
      <div class="flex items-center gap-4">
        {#each ['PHOTO', 'VIDEO', 'LANDSCAPE'] as mode}
          <button
            type="button"
            onclick={() => (cameraMode = mode as 'PHOTO' | 'VIDEO' | 'LANDSCAPE')}
            class="cursor-pointer rounded-full px-3.5 py-1 text-xs font-semibold tracking-wider uppercase transition-all duration-200 {cameraMode ===
            mode
              ? 'scale-105 border border-yellow-400/40 bg-black/60 text-yellow-400 shadow-sm'
              : 'text-gray-300 hover:text-white'}"
          >
            {mode}
          </button>
        {/each}
      </div>

      <!-- Shutter Row: Gallery Preview (Left) | Shutter Button (Center) | Flip Camera (Right) -->
      <div class="flex w-full items-center justify-between px-6 pt-1">
        <!-- Left: Gallery Preview Thumbnail (Clicking opens directly to that photo in Photos app) -->
        <button
          type="button"
          bind:this={thumbnailRef}
          onclick={() => {
            if ($photosStore.length > 0) {
              openApp('photos', {
                initialPhoto: $photosStore[0]
              });
            } else {
              openApp('photos');
            }
          }}
          class="group flex h-12 w-12 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-white/30 bg-black/40 shadow-lg transition-all duration-300 {isThumbnailBouncing
            ? 'scale-110 border-yellow-400 shadow-xl ring-2 shadow-yellow-400/30 ring-yellow-400/60'
            : 'hover:scale-105'}"
          aria-label="Open Photos Gallery"
        >
          {#if $photosStore.length > 0}
            <img
              src={$photosStore[0].image}
              alt="Recent capture"
              class="h-full w-full object-cover transition-opacity group-hover:opacity-90"
            />
          {:else}
            <PhotoIcon class="h-6 w-6 text-gray-400" />
          {/if}
        </button>

        <!-- Center: Shutter Button -->
        <button
          onclick={takePhoto}
          class="flex h-20 w-20 cursor-pointer items-center justify-center rounded-full border-4 border-white p-1 shadow-2xl transition-transform hover:scale-105 active:scale-95"
          aria-label="Take photo"
        >
          <div
            class="h-full w-full rounded-full transition-all duration-200 {cameraMode === 'VIDEO'
              ? 'scale-75 rounded-md bg-red-500'
              : 'bg-white'}"
          ></div>
        </button>

        <!-- Right: Flip Camera Button. Kept in the layout as a spacer when unsupported,
             so removing it does not re-centre the shutter. -->
        {#if canFlipCamera}
          <button
            type="button"
            onclick={toggleFlipCamera}
            class="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-white/20 text-white shadow-lg backdrop-blur-md transition-transform hover:bg-white/30 active:rotate-180"
            aria-label="Flip camera"
          >
            <FlipCameraIcon class="h-6 w-6" />
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
      class="pointer-events-none absolute z-30 origin-center rounded-2xl bg-white p-1.5 shadow-2xl"
      style="transition: transform {FLY_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity {FLY_MS}ms ease-in; {flyingPhoto.box} {flyingPhoto.style}"
    >
      <img src={flyingPhoto.src} alt="" class="h-full w-full rounded-xl object-cover" />
    </div>
  {/if}
</div>
