<script lang="ts">
  import { onMount } from 'svelte';
  import { debugData } from './utils/debug';
  import { isBrowser } from './utils/isBrowser';
  import { time } from './store/time';
  import { charge } from './store/charge';
  import { setSignal } from './store/signal';
  import { currentApp, openApp, goHome, closePhone } from './store/navigation';
  import { callStore } from './store/call';
  import { isPreviewingPhoto } from './store/camera';
  import PhoneFrame from './components/PhoneFrame.svelte';
  import { appRegistryStore } from './store/registry';
  import Home from './components/Home.svelte';
  import { fetchNui } from './utils/fetchNui';
  import { mailStore } from './store/mail';
  import { messagesStore } from './store/messages';
  import { contacts } from './store/contacts';
  import { toast } from './store/toast';
  import { bootstrapStores } from './store/bootstrap';
  import ToastContainer from './components/ToastContainer.svelte';
  import ErrorBoundary from './components/ErrorBoundary.svelte';

  let visible = $state(isBrowser());

  // Handle NUI messages
  const handleMessage = (event: MessageEvent) => {
    const { action, data } = event.data;
    if (action === 'setVisible') {
      visible = data;
      if (!visible && isFreelook) {
        isFreelook = false;
      }
    } else if (action === 'setTime') {
      time.set(data);
    } else if (action === 'setCharge') {
      if (typeof data === 'number') {
        charge.set(data);
      }
    } else if (action === 'setSignal') {
      if (typeof data === 'number') {
        setSignal(data);
      }
    } else if (action === 'installApp' || action === 'gphone:installApp') {
      if (data?.url) {
        appRegistryStore
          .loadRemoteApp(data.url)
          .then(({ manifest }) => {
            toast.show({
              type: 'success',
              message: `App '${manifest.name}' installed successfully`
            });
          })
          .catch((err) => {
            toast.show({
              type: 'error',
              message: err.message || 'Failed to install remote app'
            });
          });
      }
    } else if (action === 'uninstallApp' || action === 'gphone:uninstallApp') {
      if (data?.appId) {
        try {
          appRegistryStore.unregisterApp(data.appId);
          toast.show({
            type: 'info',
            message: 'App uninstalled'
          });
        } catch (err: any) {
          toast.show({
            type: 'error',
            message: err.message || 'Failed to uninstall app'
          });
        }
      }
    } else if (action === 'receiveMail') {
      mailStore.addReceivedMail(data);
      toast.showMail({
        sender: data.sender || 'Mail',
        subject: data.subject || 'New Message',
        onClick: () => {
          visible = true;
          openApp('mail', { mailId: data.id });
        }
      });
    } else if (action === 'receiveMessage') {
      messagesStore.addReceivedMessage(data);
      toast.showIncomingMessage({
        sender: data.senderName || data.phone || 'Message',
        message: data.message || '',
        avatar: data.avatar,
        onReply: async (replyText) => {
          if (data.conversation_id) {
            await messagesStore.sendMessage(data.conversation_id, replyText);
          }
        },
        onClick: () => {
          visible = true;
          openApp('messages', {
            conversationId: data.conversation_id,
            phone: data.phone || data.senderPhone
          });
        }
      });
    } else if (action === 'receiveContactShare' || action === 'shareContact') {
      const handleAcceptContact = async () => {
        const firstname = typeof data.firstname === 'string' ? data.firstname.trim() : '';
        const phone = typeof data.phone === 'string' ? data.phone.trim() : '';

        if (!firstname || !phone) {
          toast.show({
            type: 'error',
            message: 'Cannot add contact: missing required name or phone number'
          });
          return;
        }

        const payload = {
          firstname,
          lastname: typeof data.lastname === 'string' ? data.lastname.trim() : '',
          phone,
          email: typeof data.email === 'string' ? data.email.trim() : undefined,
          avatar: typeof data.avatar === 'string' ? data.avatar : undefined,
          favorite: typeof data.favorite === 'boolean' ? data.favorite : false
        };
        try {
          await contacts.add(payload);
          toast.show({
            type: 'success',
            message: 'Contact added to address book'
          });
        } catch (e: any) {
          toast.show({
            type: 'error',
            message: e.message || 'Failed to add contact'
          });
        }
      };

      toast.showContactShare({
        name: `${data.firstname || ''} ${data.lastname || ''}`.trim() || data.phone || 'Contact',
        phone: data.phone || '',
        avatar: data.avatar,
        onAccept: handleAcceptContact,
        onDecline: () => {
          toast.show({
            type: 'info',
            message: 'Contact share declined'
          });
        },
        onClick: handleAcceptContact
      });
    } else if (action === 'callStatus') {
      // { status: 'connected' | 'idle' | 'incoming', number: '...', name: '...' }
      if (data.status === 'incoming') {
        callStore.setIncoming(data.number, data.name);
        toast.showCall({
          name: data.name,
          number: data.number,
          onAccept: () => {
            visible = true;
            openApp('phone');
          },
          onDecline: () => {
            callStore.setStatus('idle');
            fetchNui('rejectCall', { number: data.number });
          }
        });
      } else {
        callStore.setStatus(data.status);
      }
    }
  };

  let isFreelook = false;
  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.code === 'AltLeft' || event.key === 'Alt') {
        event.preventDefault();
        // Only toggle once per key press, ignore held repeats
        if (!event.repeat && visible) {
          isFreelook = !isFreelook;
          fetchNui('toggleFreelook', { state: isFreelook });
        }
      } else if (event.key === 'Escape') {
        if ($currentApp.name !== 'home') {
          goHome();
        } else {
          closePhone();
        }
      }
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('keydown', handleKeydown);

    // Mock data for browser dev
    const now = new Date();
    debugData([
      {
        action: 'setVisible',
        data: true
      },
      {
        action: 'setTime',
        data: {
          hours: now.getHours(),
          minutes: now.getMinutes()
        }
      }
    ]);

    if (import.meta.env.DEV) {
      (window as any).triggerTestToast = (
        type: 'message' | 'contact' | 'call' | 'email' = 'message'
      ) => {
        if (type === 'message') {
          const testMsg = {
            conversation_id: 1,
            senderName: 'Ursula (Crazy Ex)',
            message: '1... 🤬😡🗯️‼️',
            phone: '555-0199',
            avatar:
              'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=500&auto=format&fit=crop&q=80'
          };
          fetchNui('receiveMessage', testMsg).catch(() => {});
          window.postMessage(
            {
              action: 'receiveMessage',
              data: testMsg
            },
            '*'
          );
        } else if (type === 'contact') {
          window.postMessage(
            {
              action: 'shareContact',
              data: {
                firstname: 'Franklin',
                lastname: 'Clinton',
                phone: '555-0177'
              }
            },
            '*'
          );
        } else if (type === 'call') {
          window.postMessage(
            {
              action: 'callStatus',
              data: {
                status: 'incoming',
                name: 'Lester Crest',
                number: '555-0155'
              }
            },
            '*'
          );
        } else if (type === 'email') {
          window.postMessage(
            {
              action: 'receiveMail',
              data: {
                sender: 'Fleeca Bank',
                subject: 'Your Monthly Account Statement is Ready'
              }
            },
            '*'
          );
        }
      };
    }

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeydown);
    };
  });

  $effect(() => {
    if (visible) {
      bootstrapStores();
    }
  });

  // Track if we are currently in the camera app and notify the client
  let wasInCameraApp = false;
  $effect(() => {
    const isCameraApp = $currentApp.name === 'camera' && visible;
    if (isCameraApp !== wasInCameraApp) {
      wasInCameraApp = isCameraApp;
      fetchNui('onCameraApp', { state: isCameraApp });
    }
  });
</script>

{#if !visible && isBrowser()}
  <button
    onclick={() => (visible = true)}
    class="fixed right-4 bottom-4 z-[9999] flex cursor-pointer items-center gap-2 rounded-full border border-gray-700 bg-gray-900/90 px-4 py-2 text-xs font-medium text-white shadow-2xl backdrop-blur-md transition-all hover:bg-gray-800"
  >
    <span class="relative flex h-2 w-2">
      <span
        class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
      ></span>
      <span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
    </span>
    Open gPhone
  </button>
{/if}

{#if visible}
  <main
    class="flex h-screen w-screen overflow-hidden p-12"
    class:items-center={$currentApp.name === 'camera'}
    class:justify-center={$currentApp.name === 'camera'}
    class:items-end={$currentApp.name !== 'camera'}
    class:justify-end={$currentApp.name !== 'camera'}
    class:bg-transparent={true}
  >
    <PhoneFrame
      transparent={$currentApp.name === 'camera' && !$isPreviewingPhoto}
      onClose={() => {
        if (isBrowser()) {
          visible = false;
        }
        closePhone();
      }}
    >
      <ToastContainer />
      {#if $currentApp.name === 'home'}
        <Home {openApp} />
      {:else if appRegistryStore.getComponent($currentApp.name)}
        {@const ActiveComponent = appRegistryStore.getComponent($currentApp.name)}
        {#key $currentApp.name}
          <ErrorBoundary appName={$currentApp.name}>
            <ActiveComponent onback={goHome} {...$currentApp.props} />
          </ErrorBoundary>
        {/key}
      {/if}
    </PhoneFrame>
  </main>
{/if}
