import { AudioSession, VideoTrack, registerGlobals } from '@livekit/react-native';
import { Room, RoomEvent, Track } from 'livekit-client';
import type { ReactNode } from 'react';
import { api } from './api';

registerGlobals();

export type MediaConnection = {
  readonly connected: boolean;
  readonly micOn: boolean;
  readonly camOn: boolean;
  readonly hearing: boolean;
  toggleMic(): Promise<void>;
  toggleCam(): Promise<void>;
  toggleHearing(): Promise<void>;
  close(): Promise<void>;
  video(userId: string): ReactNode;
};

export async function connectMedia(roomId: string, onChange: () => void): Promise<MediaConnection> {
  const { token, url } = await api.rooms.livekitToken(roomId);
  if (!token || !/^wss?:\/\//.test(url)) throw new Error('미디어 연결 주소를 확인해 주세요');
  const room = new Room({ adaptiveStream: { pixelDensity: 'screen' }, dynacast: true });
  let hearing = true;
  let closed = false;
  const syncAudio = () => {
    room.remoteParticipants.forEach((p) =>
      p.audioTrackPublications.forEach((pub) => {
        const track = pub.audioTrack;
        if (track && 'setVolume' in track) track.setVolume(hearing ? 1 : 0);
      }),
    );
    onChange();
  };
  const events = [
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.Reconnected,
    RoomEvent.Disconnected,
  ];
  events.forEach((event) => room.on(event, syncAudio));
  try {
    await AudioSession.startAudioSession();
    await room.connect(url, token);
  } catch (e) {
    room.removeAllListeners();
    try {
      await room.disconnect();
    } finally {
      await AudioSession.stopAudioSession();
    }
    throw e;
  }
  const connection: MediaConnection = {
    get connected() {
      return !closed && room.state === 'connected';
    },
    get micOn() {
      return room.localParticipant.isMicrophoneEnabled;
    },
    get camOn() {
      return room.localParticipant.isCameraEnabled;
    },
    get hearing() {
      return hearing;
    },
    async toggleMic() {
      await room.localParticipant.setMicrophoneEnabled(!connection.micOn);
      onChange();
    },
    async toggleCam() {
      await room.localParticipant.setCameraEnabled(!connection.camOn);
      onChange();
    },
    async toggleHearing() {
      hearing = !hearing;
      syncAudio();
    },
    async close() {
      if (closed) return;
      closed = true;
      room.removeAllListeners();
      try {
        await room.disconnect();
      } finally {
        await AudioSession.stopAudioSession();
      }
    },
    video(userId) {
      const participant =
        room.localParticipant.identity === userId
          ? room.localParticipant
          : room.remoteParticipants.get(userId);
      const publication = participant?.getTrackPublication(Track.Source.Camera);
      if (!participant || !publication?.track || publication.isMuted) return null;
      return (
        <VideoTrack
          trackRef={{ participant, publication, source: Track.Source.Camera }}
          style={{ width: '100%', height: '100%', position: 'absolute', borderRadius: 16 }}
        />
      );
    },
  };
  return connection;
}
