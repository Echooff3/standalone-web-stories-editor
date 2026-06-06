import React, { useState, useEffect, useCallback } from 'react';
import { StoryEditor, InterfaceSkeleton } from '@googleforcreators/story-editor';
import { elementTypes } from '@googleforcreators/element-library';
import { registerElementType } from '@googleforcreators/elements';

// Register element types for the story editor canvas
elementTypes.forEach(registerElementType);

const API_BASE = 'http://localhost:8000/api';

const mapMediaResponseToResource = (item) => {
  if (!item) return null;
  const mimeType = item.mime_type || item.mimeType || '';
  let type = 'image';
  if (mimeType.startsWith('image/')) {
    type = mimeType === 'image/gif' ? 'gif' : 'image';
  } else if (mimeType.startsWith('video/')) {
    type = 'video';
  }

  const width = Number(item.media_details?.width || item.width || 1080);
  const height = Number(item.media_details?.height || item.height || 1920);
  const src = item.source_url || item.src || '';
  const alt = item.alt_text || item.alt || '';

  const baseColor = item.meta?.web_stories_base_color || item.baseColor;
  const blurHash = item.meta?.web_stories_blurhash || item.blurHash;

  const fullSize = {
    file: item.id,
    width,
    height,
    mimeType,
    sourceUrl: src,
  };

  const sizes = {
    thumbnail: fullSize,
    medium: fullSize,
    large: fullSize,
    full: fullSize,
    ...item.media_details?.sizes,
    ...item.sizes,
  };

  const resource = {
    id: String(item.id),
    type,
    mimeType,
    src,
    width,
    height,
    alt,
    baseColor,
    blurHash,
    sizes,
  };

  if (type === 'video') {
    resource.poster = item.media_details?.poster || item.poster || '';
    resource.length = Number(item.media_details?.length || item.length || 0);
    resource.lengthFormatted = item.media_details?.length_formatted || item.lengthFormatted || '0:00';
  }

  return resource;
};

export default function App() {
  const [stories, setStories] = useState([]);
  const [activeStoryId, setActiveStoryId] = useState(null);
  const [initialStoryData, setInitialStoryData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [newStorySlug, setNewStorySlug] = useState('');

  // Fetch stories from Python backend
  const fetchStories = async () => {
    try {
      const res = await fetch(`${API_BASE}/stories`);
      if (res.ok) {
        const data = await res.json();
        setStories(data);
      }
    } catch (err) {
      console.error('Error fetching stories:', err);
    }
  };

  useEffect(() => {
    fetchStories();
  }, []);

  // API Callbacks for the Story Editor configuration
  const apiCallbacks = {
    // 1. Get Story
    getStoryById: useCallback(async (config, storyId) => {
      const res = await fetch(`${API_BASE}/stories/${storyId}`);
      if (!res.ok) throw new Error('Failed to load story');
      const data = await res.json();
      
      // Map properties back to camelCase as expected by the editor
      return {
        storyId: data.storyId,
        title: { raw: data.title },
        slug: data.slug,
        status: data.status,
        storyData: data.storyData,
      };
    }, []),

    // 2. Save/Update Story
    saveStoryById: useCallback(async (config, story) => {
      const payload = {
        storyId: story.storyId,
        title: story.title?.raw || 'Untitled',
        slug: story.slug || story.storyId,
        status: story.status || 'draft',
        story_data: {
          pages: story.pages,
          fonts: story.fonts,
          autoAdvance: story.autoAdvance,
          defaultPageDuration: story.defaultPageDuration,
          backgroundAudio: story.backgroundAudio,
        },
        content: story.content || '',
      };

      const res = await fetch(`${API_BASE}/stories/${story.storyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      if (!res.ok) throw new Error('Failed to save story');
      const data = await res.json();

      return {
        status: payload.status,
        slug: payload.slug,
        link: data.link || '',
      };
    }, []),

    // 3. Media listing
    getMedia: useCallback(async (config, { mediaType, searchTerm, pagingNum }) => {
      const sanitizedType = (mediaType === 'LOCAL_MEDIA_TYPE_ALL' || !mediaType) ? '' : mediaType;
      const query = new URLSearchParams({
        type: sanitizedType,
        search: searchTerm || '',
        page: pagingNum || 1,
      });

      const res = await fetch(`${API_BASE}/media?${query.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch media');
      const data = await res.json();

      return {
        data: (data.items || []).map(mapMediaResponseToResource),
        headers: {
          totalItems: data.totalItems,
          totalPages: data.totalPages,
        },
      };
    }, []),

    // 4. Upload media
    uploadMedia: useCallback(async (config, file, additionalData) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('additional_data', JSON.stringify({
        width: additionalData?.width || 1080,
        height: additionalData?.height || 1920,
        altText: additionalData?.altText || file.name,
      }));

      const res = await fetch(`${API_BASE}/media`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Failed to upload media');
      const uploadedData = await res.json();
      return mapMediaResponseToResource(uploadedData);
    }, []),

    // 5. Delete media
    deleteMedia: useCallback(async (config, mediaId) => {
      const res = await fetch(`${API_BASE}/media/${mediaId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete media');
    }, []),

    // Static catalog hooks
    getCurrentUser: useCallback(async () => ({ id: 1, name: 'Creator' }), []),
    getAuthors: useCallback(async () => [{ id: 1, name: 'Creator' }], []),
    getPublisherLogos: useCallback(async () => [], []),
    getFonts: useCallback(async () => {
      const res = await fetch(`${API_BASE}/fonts`);
      return res.json();
    }, []),
  };

  // Custom File Uploader logic mapped to editor trigger
  const CustomMediaUpload = ({ render, onSelect, onClose, type }) => {
    const handlePicker = useCallback(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = type.join(',');
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (file) {
          try {
            const uploadedResource = await apiCallbacks.uploadMedia({}, file, {});
            onSelect(uploadedResource);
            if (onClose) {
              onClose();
            }
          } catch (err) {
            console.error('Upload failed:', err);
          }
        }
      };
      input.click();
    }, [type, onSelect, onClose]);

    return render(handlePicker);
  };

  // Load a story into editor
  const editStory = async (storyId) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/stories/${storyId}`);
      if (res.ok) {
        const data = await res.json();
        
        // Structure the edits object expected by the editor
        setInitialStoryData({
          story: {
            storyId: data.storyId,
            title: { raw: data.title },
            slug: data.slug,
            status: data.status,
            storyData: data.storyData,
          }
        });
        setActiveStoryId(storyId);
      }
    } catch (err) {
      console.error('Error loading story:', err);
    } finally {
      setLoading(false);
    }
  };

  // Create new story draft
  const handleCreateStory = async (e) => {
    e.preventDefault();
    if (!newStoryTitle.trim()) return;

    const storyId = uuidv4();
    const slug = newStorySlug.trim() || newStoryTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    const initialPayload = {
      storyId,
      title: newStoryTitle,
      slug,
      status: 'draft',
      story_data: { pages: [], fonts: [] },
      content: '',
    };

    try {
      const res = await fetch(`${API_BASE}/stories/${storyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initialPayload),
      });

      if (res.ok) {
        setShowCreateModal(false);
        setNewStoryTitle('');
        setNewStorySlug('');
        fetchStories();
        editStory(storyId);
      }
    } catch (err) {
      console.error('Failed to create story:', err);
    }
  };

  const deleteStory = async (storyId) => {
    if (!confirm('Are you sure you want to delete this story?')) return;
    try {
      const res = await fetch(`${API_BASE}/stories/${storyId}`, { method: 'DELETE' });
      if (res.ok) {
        fetchStories();
      }
    } catch (err) {
      console.error('Error deleting story:', err);
    }
  };

  // Helper helper to generate temporary UUIDs
  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Back to Dashboard callback
  const handleCloseEditor = () => {
    if (confirm('Are you sure you want to exit the editor? Unsaved changes may be lost. Make sure to click Save Draft or Publish before exiting.')) {
      setActiveStoryId(null);
      setInitialStoryData(null);
      fetchStories();
    }
  };

  const editorConfig = {
    storyId: activeStoryId,
    apiCallbacks: apiCallbacks,
    MediaUpload: CustomMediaUpload,
    capabilities: {
      hasUploadMediaAction: true,
      canManageSettings: false,
    },
    cdnURL: 'https://wp.stories.google/static/main/',
    ffmpegCoreUrl: 'https://wp.stories.google/static/main/js/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
  };

  if (activeStoryId && initialStoryData) {
    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}>
        <header style={{
          height: '45px',
          background: '#1b1d28',
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          borderBottom: '1px solid #282a36',
          justifyContent: 'space-between',
          zIndex: 1000
        }}>
          <span style={{ fontWeight: '600', color: '#ff79c6' }}>Web Stories Studio</span>
          <button 
            onClick={handleCloseEditor}
            style={{
              background: '#bd93f9',
              border: 'none',
              color: '#1e1f29',
              padding: '6px 14px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: '600',
              fontSize: '12px'
            }}
          >
            ← Close Editor & Return
          </button>
        </header>
        <div style={{ flex: 1, position: 'relative' }}>
          <StoryEditor config={editorConfig} initialEdits={initialStoryData}>
            <InterfaceSkeleton />
          </StoryEditor>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '32px', background: 'linear-gradient(90deg, #ff79c6, #bd93f9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: '800' }}>
            Web Stories Studio
          </h1>
          <p style={{ margin: '8px 0 0 0', color: '#6272a4' }}>Standalone CMS backed by Python & Azure Blob Storage</p>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', background: '#282a36', border: '1px solid #44475a', padding: '6px 12px', borderRadius: '20px', color: '#50fa7b', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', background: '#50fa7b', borderRadius: '50%' }}></span>
            Azurite Emulator
          </span>
          <button 
            onClick={() => setShowCreateModal(true)}
            style={{
              background: 'linear-gradient(135deg, #bd93f9, #ff79c6)',
              border: 'none',
              color: '#1e1f29',
              padding: '12px 24px',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: '700',
              fontSize: '14px',
              boxShadow: '0 4px 15px rgba(189, 147, 249, 0.3)'
            }}
          >
            + New Story
          </button>
        </div>
      </header>

      {loading && <div style={{ color: '#6272a4', textAlign: 'center', padding: '40px' }}>Loading workspace...</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '24px' }}>
        {stories.map(story => (
          <div 
            key={story.storyId}
            style={{
              background: '#1b1d28',
              border: '1px solid #282a36',
              borderRadius: '12px',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              transition: 'transform 0.2s, box-shadow 0.2s',
              minHeight: '160px'
            }}
            className="story-card"
          >
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <h3 style={{ margin: 0, color: '#f8f8f2', fontSize: '18px', fontWeight: '600' }}>{story.title}</h3>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: story.status === 'publish' ? '#50fa7b' : '#ffb86c',
                  color: '#1e1f29',
                  fontWeight: '700'
                }}>
                  {story.status.toUpperCase()}
                </span>
              </div>
              <p style={{ fontSize: '12px', color: '#6272a4', margin: '0 0 20px 0' }}>
                Updated: {new Date(story.updatedAt).toLocaleString()}
              </p>
            </div>
            
            <div style={{ display: 'flex', gap: '10px' }}>
              <button 
                onClick={() => editStory(story.storyId)}
                style={{ flex: 1, background: '#282a36', border: '1px solid #44475a', color: '#f8f8f2', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
              >
                Edit
              </button>
              {story.status === 'publish' && (
                <a 
                  href={`http://127.0.0.1:10000/devstoreaccount1/published/${story.slug}.html`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#50fa7b', border: 'none', color: '#1e1f29', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '600', textDecoration: 'none' }}
                >
                  View
                </a>
              )}
              <button 
                onClick={() => deleteStory(story.storyId)}
                style={{ background: '#ff5555', border: 'none', color: '#f8f8f2', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {stories.length === 0 && !loading && (
          <div style={{ gridColumn: '1 / -1', background: '#1b1d28', border: '1px dashed #44475a', borderRadius: '12px', padding: '60px', textAlign: 'center', color: '#6272a4' }}>
            No stories found. Create a new story to get started!
          </div>
        )}
      </div>

      {showCreateModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.75)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 9999 }}>
          <form 
            onSubmit={handleCreateStory}
            style={{ background: '#1b1d28', border: '1px solid #282a36', padding: '32px', borderRadius: '12px', width: '400px', display: 'flex', flexDirection: 'column', gap: '16px' }}
          >
            <h2 style={{ margin: '0 0 10px 0', fontSize: '20px', color: '#f8f8f2' }}>Create New Story</h2>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: '#6272a4' }}>Story Title</label>
              <input 
                type="text" 
                value={newStoryTitle} 
                onChange={e => setNewStoryTitle(e.target.value)} 
                required 
                placeholder="My Awesome Story"
                style={{ background: '#282a36', border: '1px solid #44475a', padding: '10px', borderRadius: '6px', color: '#f8f8f2' }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: '#6272a4' }}>Slug (URL Name)</label>
              <input 
                type="text" 
                value={newStorySlug} 
                onChange={e => setNewStorySlug(e.target.value)} 
                placeholder="my-awesome-story"
                style={{ background: '#282a36', border: '1px solid #44475a', padding: '10px', borderRadius: '6px', color: '#f8f8f2' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <button 
                type="button" 
                onClick={() => setShowCreateModal(false)}
                style={{ flex: 1, background: '#282a36', border: '1px solid #44475a', color: '#f8f8f2', padding: '10px', borderRadius: '6px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button 
                type="submit" 
                style={{ flex: 1, background: '#bd93f9', border: 'none', color: '#1e1f29', padding: '10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '700' }}
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
