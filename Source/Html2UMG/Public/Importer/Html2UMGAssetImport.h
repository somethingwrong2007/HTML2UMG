// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Html2UMGTypes.h"
#include "Importer/Html2UMGPropertyApplier.h"
#include "Templates/Function.h"

class UPackage;
class UFont;
class UObject;
class UTexture2D;

/**
 * Imports (or reuses) the textures and fonts declared in a layout's "assets" block,
 * and resolves layout references ("@key", "/Game/...", raw file paths) to loaded UObjects.
 *
 * Everything it does is idempotent: importing the same layout twice reuses / overwrites the
 * same assets instead of leaving "_1" duplicates behind.
 */
class HTML2UMG_API FHtml2UMGAssetImport
{
public:
	FHtml2UMGAssetImport(const FH2ULayout& InLayout, const FH2UImportOptions& InOptions);

	/** Imports everything the layout declares. Errors are reported through the sink. */
	bool ImportAll(const FH2UMessageSink& Sink);

	/**
	 * Reference resolver handed to the reflection writer.
	 * "@key" -> texture/font import, "/Game/..." -> LoadObject, anything else -> file path import.
	 */
	UObject* Resolve(const FString& Reference, UClass* ExpectedClass, const FString& Context);

	/** Number of texture assets this import created (vs. reused). */
	int32 TexturesImported = 0;
	int32 TexturesReused = 0;
	/** Textures the importer could not turn into an asset (unsupported file, decode failure). */
	int32 TexturesFailed = 0;
	int32 FontsImported = 0;
	int32 FontsReused = 0;

	/** Packages that were created or modified and should be saved at the end of the import. */
	const TArray<UPackage*>& GetTouchedPackages() const { return TouchedPackages; }

	/** Errors seen while importing; the importer folds these into the result. */
	const TArray<FH2UMessage>& GetMessages() const { return Messages; }

private:
	/** Imports (or finds) the texture for a "@key" entry. */
	UTexture2D* EnsureTexture(const FString& Key, const FString& Context);

	/** Imports (or finds) the UFont for a "@key" font entry; null when the entry has no file. */
	UFont* EnsureFont(const FString& Key, const FString& Context);

	/** Adds one typeface (Regular/Bold/...) to the family font, creating the family asset if needed. */
	bool AddTypeface(const FH2UAssetRef& Ref, const FString& Context);

	/**
	 * Rebuilds the CJK fallback sub-typefaces of a family font (FCompositeFont::SubTypefaces)
	 * from every layout font entry that shares the family. Idempotent: the sub-fonts this
	 * importer created for the family are dropped first, so a reimport replaces them.
	 * Returns the number of sub-fonts added.
	 */
	int32 RebuildFallbacks(UFont& FamilyFont, const FH2UAssetRef& Ref, const FString& FamilyName, const FString& Context);

	/** Imports a TTF/OTF into a UFontFace asset, reusing it when it is already up to date. */
	UObject* ImportFontFace(const FH2UAssetRef& Ref, const FString& AbsFile, const FString& Context);

	/**
	 * Content-addressed UFontFace asset name: <Prefix><family>_<weight>[_Italic]_<md5 of the file, 8 hex>.
	 * The content hash is what keeps "same family, different file" from silently reusing the old
	 * glyphs - a bare family+weight name did exactly that.
	 */
	FString MakeFaceAssetName(const FString& Prefix, const FString& BaseName, const FString& AbsFile, int32 Weight, bool bItalic) const;

	/** Imports one fallback file into a UFontFace asset (content-addressed name, so it is shared by families). */
	UObject* ImportFallbackFace(const FH2UFontFallback& Fallback, const FString& AbsFile, const FString& Context);

	/** Shared body of ImportFontFace / ImportFallbackFace: import the file as FaceAssetName under OutputRoot. */
	UObject* ImportFontFaceAs(const FString& FaceAssetName, const FString& AbsFile, const FString& Context);

	/**
	 * Face index to bind for a weight/italic inside a multi-face font file (.ttc/.otc: msyh.ttc
	 * bundles Microsoft YaHei + Microsoft YaHei UI, msyhbd.ttc bundles the bold pair).
	 * RequestedIndex >= 0 (layout "subFace") wins; otherwise the face whose style matches the
	 * requested weight/italic is used, falling back to 0 with a warning that lists the faces.
	 * Returns 0 for single-face files, which is every .ttf/.otf.
	 */
	int32 PickSubFaceIndex(const UObject* FontFace, int32 Weight, bool bItalic, int32 RequestedIndex, const FString& Label, const FString& Context);

	/** Imports an image file into a UTexture2D asset, reusing it when it is already up to date. */
	UTexture2D* ImportTextureFile(const FString& Key, const FString& AbsFile, const FString& Context);

	/** "/Game/UI/Foo/T_Bar" -> existing asset or null. */
	UObject* FindExistingAsset(const FString& PackagePath, const FString& AssetName) const;

	FString MakeAssetName(const FString& InRaw) const;

	void Message(const FH2UMessageSink& Sink, const TCHAR* Severity, const FString& Text);

	/** Typeface entry name for a weight/italic combination. */
	static FString TypefaceNameFor(const FH2UAssetRef& Ref);

	const FH2ULayout& Layout;
	const FH2UImportOptions& Options;

	FString OutputRoot;

	/**
	 * Where THIS page's textures go: OutputRoot/<WBP name>.
	 *
	 * Importing several designs used to drop every texture into one flat folder, which makes a
	 * project impossible to clean up: you cannot tell which bitmap belongs to which screen, and a
	 * re-import cannot remove stale ones. One folder per widget blueprint keeps a page's assets
	 * together and makes "delete this page" a folder delete.
	 */
	FString TextureRoot;

	/** Bitmaps left in TextureRoot that this layout does not use and that nothing proves is in use. */
	void GatherUnusedTextures(TArray<UObject*>& OutUnused, TArray<FString>& OutNames) const;
	/** Logs the candidates without deleting them (the safe default). */
	void ReportUnusedTextures(const FH2UMessageSink& Sink);
	/** Deletes the candidates. Opt-in only: see the warning on bPruneUnusedPageAssets. */
	void PruneUnusedTextures(const FH2UMessageSink& Sink);

	/** Fonts stay shared: the same face is reused by every page that asks for it. */
	FString FontRoot;

	/** "@tex_N" -> texture. */
	TMap<FString, TObjectPtr<UTexture2D>> TextureCache;
	/** family (lower-case) -> font family asset. */
	TMap<FString, TObjectPtr<UFont>> FontCache;
	/** "@font_N" -> font family asset. */
	TMap<FString, TObjectPtr<UFont>> FontKeyCache;
	/** absolute file -> imported asset, so the same file is imported once. */
	TMap<FString, TWeakObjectPtr<UObject>> FileCache;

	TSet<FString> ReportedMissing;

	TArray<UPackage*> TouchedPackages;
	TArray<FH2UMessage> Messages;
	FH2UMessageSink ActiveSink;
	bool bHasErrors = false;
};
