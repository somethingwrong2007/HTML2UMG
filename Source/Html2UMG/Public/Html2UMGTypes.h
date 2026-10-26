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

/** A texture or font file referenced by the layout, by key. */
struct HTML2UMG_API FH2UAssetRef
{
	FString Key;
	FString File;      // relative to the layout json directory, or absolute
	FString Family;    // fonts only
	int32 Weight = 400;
	bool bItalic = false;
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
}
