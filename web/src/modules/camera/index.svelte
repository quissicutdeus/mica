<script lang="ts">
  import { useCamera, useNavigation, useNuiBridge, onAppMount } from '@gphone/sdk';
  import { isBrowser } from '../../utils/isBrowser';

  const { capturePhoto, photosStore, isTakingPhoto, isPreviewingPhoto } = useCamera();
  const { openApp } = useNavigation();
  import { sampleAvatars } from '../../mocks/data';
  import CloseIcon from '../../components/icons/CloseIcon.svelte';
  import FlipCameraIcon from '../../components/icons/FlipCameraIcon.svelte';
  import PhotoIcon from '../../components/icons/PhotoIcon.svelte';
  import { onDestroy } from 'svelte';

  let { onback } = $props<{ onback: () => void }>();

  const { fetchNui } = useNuiBridge();

  let cameraMode = $state<'PHOTO' | 'VIDEO' | 'LANDSCAPE'>('PHOTO');
  let isFrontCamera = $state(false);
  let isFlashing = $state(false);
  let isThumbnailBouncing = $state(false);

  let mockPhotoIndex = $state(1);
  let currentViewfinderImage = $derived(sampleAvatars[mockPhotoIndex % sampleAvatars.length]);

  let containerRef = $state<HTMLElement | null>(null);

  onAppMount(() => {
    photosStore.load();
  });

  onDestroy(() => {
    isPreviewingPhoto.set(false);
  });

  const toggleFlipCamera = async () => {
    isFrontCamera = !isFrontCamera;
    try {
      await fetchNui('flipCamera', { isFrontCamera });
    } catch (e) {
      console.error('Failed to flip camera', e);
    }
  };

  const takePhoto = async () => {
    isTakingPhoto.set(true);

    // Get the phone dimensions from the container before hiding it
    const rect = containerRef?.getBoundingClientRect();

    // Trigger flash animation strictly inside picture viewfinder area on shutter click
    isFlashing = true;
    setTimeout(() => {
      isFlashing = false;
    }, 180);

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
              img.src = base64Data.startsWith('data:')
                ? base64Data
                : 'data:image/jpeg;base64,' + base64Data;

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
                  const cropped = canvas.toDataURL('image/jpeg', 0.5);
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

        // Trigger gallery thumbnail bounce highlight
        isThumbnailBouncing = true;
        setTimeout(() => {
          isThumbnailBouncing = false;
        }, 600);
      } catch (err) {
        console.error('Failed to take photo', err);
      } finally {
        isTakingPhoto.set(false);
      }
    }, CHROME_FADE_MS + 30);
  };
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

    <!-- Viewfinder Picture Shutter Flash Overlay (Only over picture area, behind controls) -->
    {#if isFlashing}
      <div
        class="pointer-events-none absolute inset-0 z-0 bg-white transition-opacity duration-150"
      ></div>
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

        <!-- Right: Flip Camera Button -->
        <button
          type="button"
          onclick={toggleFlipCamera}
          class="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-white/20 text-white shadow-lg backdrop-blur-md transition-transform hover:bg-white/30 active:rotate-180"
          aria-label="Flip camera"
        >
          <FlipCameraIcon class="h-6 w-6" />
        </button>
      </div>
    </div>
  </div>
</div>
