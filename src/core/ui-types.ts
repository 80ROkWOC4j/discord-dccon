import type * as React from 'react';
import type {Con, Pack, PackId, PackSearchResult, PreparedCon, SearchResult} from './types.ts';
export interface ImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'onError'> {src: string; onError?: () => void}
export interface ChannelProps {channelId: string}
export interface BufferImageProps {file: File; title?: string; className?: string}
export interface PersonalImageProps {con: Con; className?: string; onError?: () => void}
export interface ThumbnailProps {pack: Pack; className?: string; style?: React.CSSProperties}
export interface ItemProps {con: Con; packageIdx?: PackId}
export interface PanelProps {type: string; onManage?: () => void}
export interface PanelState {textFilter: string; selected: string; dccons: Pack[]; semanticResults?: SearchResult[]; searchError?: string; searching?: boolean; revision?: number}
export interface PersonalState {items: Con[]; open: boolean; input: string; title: string; prepared: PreparedCon | null; busy: boolean; message: string}
export interface CardProps {item: PackSearchResult; savedDccons: Pack[]; onAdd(pack: Pack): void}
export interface SavedCardProps {title: string; thumbnail: React.ReactNode; description?: string; isFirst: boolean; isLast: boolean; disabled?: boolean; onMove(direction: number): void; onRemove(): void}
export interface SettingsState {activeTab: string; searchQuery: string; searchResults: PackSearchResult[]; isSearching: boolean; savedDccons: Pack[]; diagnosticReport?: string; copyStatus?: string}
export interface ButtonProps {text: React.ReactNode; color?: string; disabled?: boolean; style?: React.CSSProperties; onClick?: React.MouseEventHandler<HTMLButtonElement>}
