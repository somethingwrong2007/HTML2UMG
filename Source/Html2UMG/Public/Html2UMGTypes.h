// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** One severity-tagged message produced by the converter or the importer. */
struct HTML2UMG_API FH2UMessage
{
	FString Severity; // "error" | "warning" | "info"
	FString Text;

	FH2UMessage() = default;
	FH2UMessage(const FString& InSeverity, const FString& InText) : Severity(InSeverity), Text(InText) {}

	bool IsError() const { return Severity.Equals(TEXT("error"), ESearchCase::IgnoreCase); }
};

/** An inclusive codepoint span, e.g. {0x4E00, 0x9FFF}. */
struct HTML2UMG_API FH2UCharRange
{
	int32 First = 0;
	int32 Last = 0;
};

/**
 * One extra font file to consult when the primary face of a family has no glyph for a character,
 * e.g. the CJK face the browser actually fell back to for Chinese text.
 * Emitted by the converter as assets.fonts[].fallbacks[]; optional, and older layouts omit it.
 */
struct HTML2UMG_API FH2UFontFallback
{
	FString Key;       // also declared as a normal assets.fonts[] entry; used to skip a redundant family asset
	FString Family;    // fonts only; used to name the imported asset
	FString File;      // TTF/TTC/OTF/OTC, relative to the layout json directory, or absolute
	int32 Weight = 400;
	bool bItalic = false;
	/** Face inside a multi-face file (.ttc/.otc); -1 = pick by weight/italic from the file's faces. */
	int32 SubFace = -1;
	/**
	 * Codepoints this face actually covers (the converter scans the font's cmap), as inclusive
	 * [first, last] pairs. Empty for layouts written before the field existed, in which case the
	 * importer falls back to its built-in CJK block table. Never overlaps another fallback's
	 * coverage - the converter splits the chain so each face owns its own range.
	 */
	TArray<FH2UCharRange> Coverage;
};

/** A texture or font file referenced by the layout, by key. */
struct HTML2UMG_API FH2UAssetRef
{
	FString Key;
	FString File;      // relative to the layout json directory, or absolute
	FString Family;    // fonts only
	int32 Weight = 400;
	bool bItalic = false;
	/** Face inside a multi-face file (.ttc/.otc); -1 = pick by weight/italic from the file's faces. */
	int32 SubFace = -1;

	/** Faces the browser used for characters the primary face lacks (fonts only; may be empty). */
	TArray<FH2UFontFallback> Fallbacks;
};

/**
 * A node of the layout tree. The typed fields are the ones the importer acts on;
 * Properties/Slot/Brush stay as raw JSON because they are generic reflection payloads
 * (see Docs/Html2UMG_LayoutContract.md, section 3).
 */
struct HTML2UMG_API FH2UNode
{
	FString Name;
	FString ClassName;
	FString Source;                 // debug: originating DOM selector
	int32 Variable = -1;            // -1 = unspecified (defaults to true)

	TSharedPtr<FJsonObject> Properties;
	TSharedPtr<FJsonObject> Slot;
	TSharedPtr<FJsonObject> Brush;

	/**
	 * Name of a UNamedSlot inside the parent that this node should be inserted into instead of
	 * the parent's default child list. Used when reusing an already imported widget that declares
	 * named slots (contract field "namedSlot").
	 */
	FString NamedSlot;

	TArray<TSharedPtr<FH2UNode>> Children;

	bool IsVariable() const { return Variable != 0; }
};

/** Parsed layout document. */
struct HTML2UMG_API FH2ULayout
{
	int32 ContractVersion = 1;
	FString Generator;
	FString SourcePath;
	FString BlueprintPath;
	FString ParentClassPath;
	FVector2D Viewport = FVector2D(1920.0, 1080.0);

	TMap<FString, FH2UAssetRef> Textures;
	TMap<FString, FH2UAssetRef> Fonts;
	TArray<FString> Warnings;

	TSharedPtr<FH2UNode> Root;

	/** Directory the json lives in; relative asset paths resolve against it. */
	FString BaseDirectory;

	bool IsValid() const { return Root.IsValid(); }

	/** Resolve an asset reference ("@key", absolute path, or path relative to BaseDirectory) to an absolute filename. */
	bool ResolveAssetFile(const FString& InRef, FString& OutAbsFile, FString& OutKey) const;

	static bool ParseFromFile(const FString& FilePath, FH2ULayout& OutLayout, TArray<FH2UMessage>& OutMessages);
	static bool ParseFromString(const FString& JsonText, const FString& InBaseDirectory, FH2ULayout& OutLayout, TArray<FH2UMessage>& OutMessages);
};

/** Options controlling a single import. */
struct HTML2UMG_API FH2UImportOptions
{
	/** Overrides the layout's "blueprint" field. Empty = use the layout's. */
	FString BlueprintPath;
	/** Overrides the layout's "parentClass". */
	FString ParentClassPath;
	/** Content root for imported textures/fonts, e.g. /Game/UI/Html2UMG. */
	FString AssetOutputRoot = TEXT("/Game/Html2UMG");
	/**
	 * Give every imported page its own folder: /Game/X/WBP_Foo -> /Game/X/WBP_Foo/WBP_Foo.
	 *
	 * The page's textures then live in /Game/X/WBP_Foo/assets, so a page is one self-contained
	 * folder: delete it and nothing of that page is left behind. Fonts stay shared
	 * (AssetOutputRoot/Fonts) because the same face is reused by every page.
	 */
	bool bNestPageFolder = true;
	/** Where font families go. Empty = AssetOutputRoot/Fonts. */
	FString FontOutputRoot;
	/** Delete bitmaps in <page>/assets that the layout no longer uses (they belong to this page). */
	bool bPruneUnusedPageAssets = true;

	bool bImportTextures = true;
	bool bImportFonts = true;
	/** Rebuild an existing blueprint's widget tree in place (keeps graphs and BindWidget bindings). */
	bool bReimportInPlace = true;
	/** Compile the blueprint after import. */
	bool bCompile = true;
	/** Save the package after import. */
	bool bSave = true;
	/** Multiplier applied to every size/offset (design px -> UMG px). */
	float UIScale = 1.0f;
};

/** Outcome of an import. */
struct HTML2UMG_API FH2UImportResult
{
	bool bSuccess = false;
	int32 WidgetsCreated = 0;
	int32 WidgetsReused = 0;
	int32 PropertiesSet = 0;
	FString BlueprintPath;
	TArray<FH2UMessage> Messages;

	void Error(const FString& M) { Messages.Emplace(TEXT("error"), M); }
	void Warning(const FString& M) { Messages.Emplace(TEXT("warning"), M); }
	void Info(const FString& M) { Messages.Emplace(TEXT("info"), M); }

	int32 ErrorCount() const;
	int32 WarningCount() const;
	/** Single string for logs / UI: one message per line. */
	FString ToText() const;
};

namespace Html2UMG
{
	/** "my panel #1" -> "MyPanel_1"; guarantees a legal, non-empty identifier. */
	HTML2UMG_API FString SanitizeWidgetName(const FString& InRaw);

	/** Makes a set of names unique by appending _1, _2, ... */
	HTML2UMG_API void MakeUniqueNames(TArray<FString>& Names);

	/**
	 * "/Game/UI/WBP_Foo" -> "/Game/UI/WBP_Foo/WBP_Foo" (idempotent).
	 *
	 * Every imported page gets its own folder so its textures can live next to it in
	 * <folder>/assets: one page, one folder, delete it and nothing of that page is left behind.
	 */
	HTML2UMG_API FString NestPageFolder(const FString& PackagePath);

	/** The page folder for a blueprint path: "<folder>/<name>" after NestPageFolder(). */
	HTML2UMG_API FString PageFolderOf(const FString& PackagePath);
}
