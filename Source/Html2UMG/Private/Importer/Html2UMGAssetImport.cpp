// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Importer/Html2UMGAssetImport.h"

#include "AssetImportTask.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Engine/Font.h"
#include "Engine/FontFace.h"
#include "Engine/Texture2D.h"
#include "Factories/FontFileImportFactory.h"
#include "Factories/TextureFactory.h"
#include "Fonts/CompositeFont.h"
#include "Framework/Application/SlateApplication.h"
#include "FileHelpers.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/SecureHash.h"
#include "Html2UMGLog.h"
#include "IAssetTools.h"
#include "Misc/DateTime.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace
{
	FString NormalizeRoot(const FString& InRoot)
	{
		FString Root = InRoot.IsEmpty() ? FString(TEXT("/Game/Html2UMG")) : InRoot;
		Root.ReplaceInline(TEXT("\\"), TEXT("/"));
		while (Root.EndsWith(TEXT("/")))
		{
			Root.LeftChopInline(1);
		}
		return Root;
	}

	/**
	 * Short content hash of a source file, used to make imported asset names content-addressed.
	 * Returns an empty string when the file cannot be read (caller falls back to the plain name).
	 */
	FString HashSourceFile(const FString& SourceFile)
	{
		TArray<uint8> Bytes;
		if (!FFileHelper::LoadFileToArray(Bytes, *SourceFile) || Bytes.Num() == 0)
		{
			return FString();
		}
		const FMD5Hash Hash = FMD5Hash::HashFile(*SourceFile);
		return LexToString(Hash).Left(8);
	}

	/** True when the asset package on disk is at least as new as the source file. */
	bool IsAssetUpToDate(const FString& PackageName, const FString& SourceFile)
	{
		const FString PackageFile = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
		const FDateTime AssetTime = IFileManager::Get().GetTimeStamp(*PackageFile);
		const FDateTime SourceTime = IFileManager::Get().GetTimeStamp(*SourceFile);
		if (AssetTime == FDateTime::MinValue() || SourceTime == FDateTime::MinValue())
		{
			return false;
		}
		return AssetTime >= SourceTime;
	}

	/** Resolves a layout-relative or absolute file reference. */
	bool ResolveSourceFile(const FH2ULayout& Layout, const FString& InFileRef, FString& OutAbsFile)
	{
		OutAbsFile.Reset();
		if (InFileRef.IsEmpty())
		{
			return false;
		}

		FString Relative = InFileRef;
		if (Relative.StartsWith(TEXT("@")))
		{
			return Layout.ResolveAssetFile(InFileRef, OutAbsFile, Relative);
		}

		const FString Candidate = FPaths::IsRelative(Relative)
			? FPaths::Combine(Layout.BaseDirectory, Relative)
			: Relative;
		OutAbsFile = FPaths::ConvertRelativePathToFull(Candidate);
		FPaths::NormalizeFilename(OutAbsFile);
		return IFileManager::Get().FileExists(*OutAbsFile);
	}

	/**
	 * Unicode blocks a CJK fallback face is consulted for.
	 *
	 * FInt32Range is a HALF-OPEN range ([lower, upper)), so every upper bound is one past the
	 * last codepoint of the block - FInt32Range(0x4E00, 0x9FFF) would drop U+9FFF.
	 * Consumed by Slate in FCachedCompositeFontData::RefreshFontRanges (FontCacheCompositeFont.cpp).
	 */
	const TArray<FInt32Range>& GetCjkCharacterRanges()
	{
		static const TArray<FInt32Range> Blocks = {
			FInt32Range(0x2E80, 0x2FE0),   // CJK radicals supplement + Kangxi radicals
			FInt32Range(0x2FF0, 0x3000),   // ideographic description characters
			FInt32Range(0x3000, 0x3040),   // CJK symbols and punctuation
			FInt32Range(0x3040, 0x3100),   // hiragana + katakana
			FInt32Range(0x3100, 0x3130),   // bopomofo
			FInt32Range(0x3190, 0x31A0),   // kanbun
			FInt32Range(0x31C0, 0x31F0),   // CJK strokes
			FInt32Range(0x3200, 0x32A0),   // enclosed CJK letters and months
			FInt32Range(0x32C0, 0x3400),   // enclosed CJK compatibility + CJK compatibility
			FInt32Range(0x3400, 0x4DC0),   // CJK unified ideographs extension A
			FInt32Range(0x4E00, 0xA000),   // CJK unified ideographs
			FInt32Range(0xF900, 0xFB00),   // CJK compatibility ideographs
			FInt32Range(0xFE10, 0xFE1A),   // vertical forms
			FInt32Range(0xFE30, 0xFE50),   // CJK compatibility forms
			FInt32Range(0xFF00, 0xFFF0),   // halfwidth and fullwidth forms
			FInt32Range(0x20000, 0x2FA20), // supplementary ideographic plane (ext B-F, compat supplement)
		};
		return Blocks;
	}

	/**
	 * Every typeface name text can request: mapper.js typefaceName() emits
	 * Regular / Bold / Italic / BoldItalic, and STextBlock leaves TypefaceFontName as NAME_None
	 * when the layout does not set one.
	 */
	const TArray<FName>& GetRequestableTypefaceNames()
	{
		static const TArray<FName> Names = {
			NAME_None,
			FName(TEXT("Regular")),
			FName(TEXT("Bold")),
			FName(TEXT("Italic")),
			FName(TEXT("BoldItalic")),
		};
		return Names;
	}

	/** The family a font entry belongs to: its declared family, else the file's base name. */
	FString FamilyNameOf(const FH2UAssetRef& Ref)
	{
		return Ref.Family.IsEmpty() ? FPaths::GetBaseFilename(Ref.File) : Ref.Family;
	}

	/** True when a face's FreeType style name ("Bold", "Bold Italic", ...) carries one of the tokens. */
	bool StyleHasAnyToken(const FString& Style, std::initializer_list<const TCHAR*> Tokens)
	{
		for (const TCHAR* Token : Tokens)
		{
			if (Style.Contains(Token, ESearchCase::IgnoreCase))
			{
				return true;
			}
		}
		return false;
	}
}

FHtml2UMGAssetImport::FHtml2UMGAssetImport(const FH2ULayout& InLayout, const FH2UImportOptions& InOptions)
	: Layout(InLayout)
	, Options(InOptions)
	, OutputRoot(NormalizeRoot(InOptions.AssetOutputRoot))
	, TextureRoot(NormalizeRoot(InOptions.AssetOutputRoot) + TEXT("/") + Html2UMG::SanitizeWidgetName(FPackageName::GetShortName(Layout.BlueprintPath)))
	, FontRoot(NormalizeRoot(InOptions.AssetOutputRoot) + TEXT("/Fonts"))
{
}

void FHtml2UMGAssetImport::Message(const FH2UMessageSink& Sink, const TCHAR* Severity, const FString& Text)
{
	Messages.Emplace(Severity, Text);
	if (FString(Severity).Equals(TEXT("error"), ESearchCase::IgnoreCase))
	{
		bHasErrors = true;
	}

	const FH2UMessageSink& Effective = Sink ? Sink : ActiveSink;
	if (Effective)
	{
		Effective(Messages.Last());
	}

	UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG [%s] %s"), Severity, *Text);
}

FString FHtml2UMGAssetImport::MakeAssetName(const FString& InRaw) const
{
	return Html2UMG::SanitizeWidgetName(InRaw);
}

FString FHtml2UMGAssetImport::TypefaceNameFor(const FH2UAssetRef& Ref)
{
	// 600, not 700: mapper.js typefaceName() treats CSS weight >= 600 as bold, and the
	// TypefaceFontName the text requests has to match the entry name we register here.
	if (Ref.Weight >= 600)
	{
		return Ref.bItalic ? TEXT("BoldItalic") : TEXT("Bold");
	}
	return Ref.bItalic ? TEXT("Italic") : TEXT("Regular");
}

UObject* FHtml2UMGAssetImport::FindExistingAsset(const FString& PackagePath, const FString& AssetName) const
{
	const FString ObjectPath = FString::Printf(TEXT("%s/%s.%s"), *PackagePath, *AssetName, *AssetName);
	const FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
	const FAssetData AssetData = AssetRegistryModule.Get().GetAssetByObjectPath(FSoftObjectPath(ObjectPath));
	if (!AssetData.IsValid())
	{
		return nullptr;
	}
	return AssetData.FastGetAsset(true);
}

bool FHtml2UMGAssetImport::ImportAll(const FH2UMessageSink& Sink)
{
	ActiveSink = Sink;

	// Say where this page's bitmaps land before importing: with several designs in one project the
	// flat layout made it impossible to tell which texture belonged to which screen.
	if (Layout.Textures.Num() > 0)
	{
		Message(Sink, TEXT("info"), FString::Printf(TEXT("assets: %d texture(s) -> %s (fonts -> %s)"),
			Layout.Textures.Num(), *TextureRoot, *FontRoot));
	}

	// Textures first: widgets reference them while building.
	for (const TPair<FString, FH2UAssetRef>& Pair : Layout.Textures)
	{
		if (!Options.bImportTextures)
		{
			Message(Sink, TEXT("info"), FString::Printf(TEXT("Texture '%s' skipped (texture import disabled)."), *Pair.Key));
			continue;
		}
		EnsureTexture(Pair.Key, TEXT("asset import"));
	}

	// The converter also lists every fallback as a normal font entry so its key resolves. Importing
	// those eagerly would create a UFont family asset per fallback family (a Chinese-only font asset
	// nobody references); they are imported on demand instead, via Resolve("@key") in the widget build.
	TSet<FString> FallbackOnlyKeys;
	for (const TPair<FString, FH2UAssetRef>& Pair : Layout.Fonts)
	{
		for (const FH2UFontFallback& Fallback : Pair.Value.Fallbacks)
		{
			if (!Fallback.Key.IsEmpty())
			{
				FallbackOnlyKeys.Add(Fallback.Key);
			}
		}
	}

	for (const TPair<FString, FH2UAssetRef>& Pair : Layout.Fonts)
	{
		if (!Options.bImportFonts)
		{
			Message(Sink, TEXT("info"), FString::Printf(TEXT("Font '%s' skipped (font import disabled)."), *Pair.Key));
			continue;
		}

		if (FallbackOnlyKeys.Contains(Pair.Key))
		{
			// Still referenced by name elsewhere: Resolve() creates the family asset if a TextBlock
			// actually uses it as its primary font.
			Message(Sink, TEXT("info"), FString::Printf(TEXT("Font '%s' is used as a glyph fallback; its family asset is created on demand."), *Pair.Key));
			continue;
		}

		EnsureFont(Pair.Key, TEXT("asset import"));
	}

	// Every family font that was built has to be queued for saving. A miss means the composite font
	// only lives in memory this session, so the next run loads the previous sub-fonts from disk -
	// the failure mode behind "removing fallbacks produced an identical render".
	for (const TPair<FString, TObjectPtr<UFont>>& Pair : FontCache)
	{
		UFont* FamilyFont = Pair.Value;
		if (!FamilyFont)
		{
			continue;
		}
		UPackage* Package = FamilyFont->GetOutermost();
		if (Package && !TouchedPackages.Contains(Package))
		{
			Message(Sink, TEXT("warning"), FString::Printf(TEXT("Font family '%s' was built but its package '%s' is not queued for saving; the composite font may not persist."),
				*Pair.Key, *Package->GetName()));
		}
	}

	return !bHasErrors;
}

UTexture2D* FHtml2UMGAssetImport::EnsureTexture(const FString& Key, const FString& Context)
{
	if (const TObjectPtr<UTexture2D>* Cached = TextureCache.Find(Key))
	{
		return *Cached;
	}

	const FH2UAssetRef* Ref = Layout.Textures.Find(Key);
	if (!Ref)
	{
		if (!ReportedMissing.Contains(Key))
		{
			ReportedMissing.Add(Key);
			Message(nullptr, TEXT("error"), FString::Printf(TEXT("%s: texture key '%s' is not declared in the layout's assets.textures."),
				*Context, *Key));
		}
		return nullptr;
	}

	if (Ref->File.IsEmpty())
	{
		Message(nullptr, TEXT("warning"), FString::Printf(TEXT("%s: texture '%s' has no file; the brush will have no image."), *Context, *Key));
		return nullptr;
	}

	FString AbsFile;
	if (!ResolveSourceFile(Layout, FString::Printf(TEXT("@%s"), *Key), AbsFile))
	{
		Message(nullptr, TEXT("error"), FString::Printf(TEXT("%s: texture '%s' file '%s' was not found (resolved from '%s')."),
			*Context, *Key, *AbsFile, *Layout.BaseDirectory));
		return nullptr;
	}

	UTexture2D* Texture = ImportTextureFile(Key, AbsFile, Context);
	if (Texture)
	{
		TextureCache.Add(Key, Texture);
	}
	return Texture;
}

UTexture2D* FHtml2UMGAssetImport::ImportTextureFile(const FString& Key, const FString& AbsFile, const FString& Context)
{
	// One asset per source file *content*, not per file name.
	//
	// The bake writes positional names (tex_0, tex_1, ...), so two different designs collide on the
	// same asset names and a re-bake that is not newer than the old package silently keeps the OLD
	// bitmap: the widget then references a perfectly valid texture that shows the wrong picture, which
	// looks exactly like a broken style mapping. Appending a content hash makes the name a function of
	// the bytes, so an existing asset with this name is guaranteed to be the right picture and the
	// mtime-based reuse below becomes safe.
	const FString SourceHash = HashSourceFile(AbsFile);
	const FString BaseName = MakeAssetName(FPaths::GetBaseFilename(AbsFile));
	const FString AssetName = SourceHash.IsEmpty()
		? BaseName
		: FString::Printf(TEXT("%s_%s"), *BaseName, *SourceHash);
	const FString PackageName = TextureRoot + TEXT("/") + AssetName;

	// Textures are always re-imported, never reused.
	//
	// Reuse was measured to be WRONG, not merely slow: the same layout json, the same on-disk png
	// and the same asset name rendered with its baked colours when the packages were imported
	// fresh, and rendered untextured when the packages already existed and were reused
	// (a widget render went 3.14% -> 4.47% of differing pixels against the browser, and the
	// slider's blue track simply disappeared). The asset name is content-addressed (see above), so
	// a reuse here cannot be selecting different pixels - the reused UTexture2D is simply not
	// usable by Slate in that run. These are small UI textures, so importing unconditionally is
	// cheap and removes a whole class of "why does it look different the second time" reports.
	//
	// Update in place so an unrelated asset cannot keep an old name.
	UTexture2D* ExistingTexture = Cast<UTexture2D>(FindExistingAsset(TextureRoot, AssetName));

	UAssetImportTask* Task = NewObject<UAssetImportTask>();
	Task->Filename = AbsFile;
	Task->DestinationPath = TextureRoot;
	Task->DestinationName = AssetName;
	Task->bReplaceExisting = true;
	// Settings are replaced as well. With bReplaceExistingSettings=false the importer keeps
	// whatever settings the previous package had, so a texture reused under the same
	// (content-addressed) name can come back configured differently than its pixels need -
	// observed as a correctly imported png rendering with the wrong colours.
	Task->bReplaceExistingSettings = true;
	Task->bAutomated = true;
	Task->bSave = false;
	Task->Factory = NewObject<UTextureFactory>();

	TArray<UAssetImportTask*> Tasks;
	Tasks.Add(Task);

	IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
	AssetTools.ImportAssetTasks(Tasks);

	UTexture2D* Texture = nullptr;
	for (UObject* Imported : Task->GetObjects())
	{
		if (UTexture2D* ImportedTexture = Cast<UTexture2D>(Imported))
		{
			Texture = ImportedTexture;
			break;
		}
	}

	if (!Texture)
	{
		// A texture that cannot be imported must not fail the whole import: the widget that wanted
		// it simply keeps its vector fallback, and everything else in the design still lands.
		// This is how a single unsupported file (an .svg, say) used to abort a 1232-widget import.
		Message(nullptr, TEXT("warning"), FString::Printf(
			TEXT("%s: texture '%s' could not be imported from '%s'; the node keeps its vector styling."),
			*Context, *Key, *AbsFile));
		++TexturesFailed;
		return nullptr;
	}

	// Force a deterministic texture format for imported UI art.
	//
	// UTextureFactory picks a format from whatever it infers about the source, and the result was
	// observed to vary between otherwise identical bakes: one of five gradient textures came back
	// in a two-channel format whose blue channel decodes to 0, so a blue/purple card rendered
	// green/amber while its png on disk was correct. These textures are small UI art, so storing
	// them uncompressed with sRGB on and no mip chain is both deterministic and the highest
	// fidelity: no DXT banding on gradients, no mip blur on a 16px tick.
	Texture->CompressionSettings = TC_EditorIcon;
	Texture->CompressionNone = true;
	Texture->MipGenSettings = TMGS_NoMipmaps;
	Texture->SRGB = true;
	Texture->NeverStream = true;
	Texture->Filter = TF_Bilinear;
	Texture->AddressX = TA_Clamp;
	Texture->AddressY = TA_Clamp;
	Texture->PostEditChange();
	Texture->UpdateResource();

	++TexturesImported;
	TouchedPackages.AddUnique(Texture->GetOutermost());
	Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: texture '%s' imported to %s."), *Context, *Key, *Texture->GetPathName()));
	return Texture;
}

UFont* FHtml2UMGAssetImport::EnsureFont(const FString& Key, const FString& Context)
{
	if (const TObjectPtr<UFont>* Cached = FontKeyCache.Find(Key))
	{
		return *Cached;
	}

	const FH2UAssetRef* Ref = Layout.Fonts.Find(Key);
	if (!Ref)
	{
		if (!ReportedMissing.Contains(Key))
		{
			ReportedMissing.Add(Key);
			Message(nullptr, TEXT("error"), FString::Printf(TEXT("%s: font key '%s' is not declared in the layout's assets.fonts."), *Context, *Key));
		}
		return nullptr;
	}

	if (Ref->File.IsEmpty())
	{
		// Deliberate: the converter can emit a family-only entry, and UMG's default font is a fine fallback.
		// A composite font needs a primary face to hang the sub-typefaces off, so the fallbacks are
		// dropped here rather than producing a UFont with an empty DefaultTypeface.
		if (Ref->Fallbacks.Num() > 0)
		{
			Message(nullptr, TEXT("warning"), FString::Printf(
				TEXT("%s: font '%s' (family '%s') has no file, so its %d fallback(s) cannot be used - a fallback is a ")
				TEXT("sub-font and needs a primary face. Declare the family's own file in assets.fonts; TextBlock keeps the default UMG font."),
				*Context, *Key, Ref->Family.IsEmpty() ? TEXT("<unnamed>") : *Ref->Family, Ref->Fallbacks.Num()));
			return nullptr;
		}

		Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: font '%s' (family '%s') has no file; TextBlock keeps the default UMG font."),
			*Context, *Key, Ref->Family.IsEmpty() ? TEXT("<unnamed>") : *Ref->Family));
		return nullptr;
	}

	// Importing a TTF/OTF compiles it into a Slate font-cache atlas, which requires a live
	// FSlateApplication. Commandlets (-run=...) run without Slate (LaunchEngineLoop skips creating
	// it when IsRunningCommandlet()), so the import would assert inside SlateApplication.h.
	// Degrade to the default font instead of taking the process down; sizes/colours/layout are unaffected.
	if (!FSlateApplication::IsInitialized())
	{
		Message(nullptr, TEXT("warning"), FString::Printf(
			TEXT("%s: font '%s' skipped - importing font files needs the editor's Slate application. ")
			TEXT("Run the import from the Tools > Html2UMG panel (or pre-import the font once); text size and colour are still applied."),
			*Context, *Key));
		return nullptr;
	}

	if (AddTypeface(*Ref, Context))
	{
		if (const TObjectPtr<UFont>* Family = FontCache.Find(Ref->Family.ToLower()))
		{
			FontKeyCache.Add(Key, *Family);
			return *Family;
		}
	}

	return nullptr;
}

bool FHtml2UMGAssetImport::AddTypeface(const FH2UAssetRef& Ref, const FString& Context)
{
	FString AbsFile;
	if (!ResolveSourceFile(Layout, Ref.File, AbsFile))
	{
		Message(nullptr, TEXT("error"), FString::Printf(TEXT("%s: font file '%s' (family '%s') was not found."),
			*Context, *Ref.File, *Ref.Family));
		return false;
	}

	UObject* FontFace = ImportFontFace(Ref, AbsFile, Context);
	if (!FontFace)
	{
		return false;
	}

	const FString Family = Ref.Family.IsEmpty() ? FPaths::GetBaseFilename(AbsFile) : Ref.Family;
	const FString FamilyKey = Family.ToLower();
	const FString FamilyAssetName = MakeAssetName(Family);
	const FString FamilyPackageName = FontRoot + TEXT("/") + FamilyAssetName;

	UFont* FamilyFont = nullptr;
	bool bFamilyReused = false;
	if (const TObjectPtr<UFont>* Cached = FontCache.Find(FamilyKey))
	{
		FamilyFont = *Cached;
		bFamilyReused = true;
	}
	else if (UObject* Existing = FindExistingAsset(FontRoot, FamilyAssetName))
	{
		FamilyFont = Cast<UFont>(Existing);
		if (FamilyFont)
		{
			++FontsReused;
			bFamilyReused = true;
		}
	}

	if (!FamilyFont)
	{
		UPackage* Package = CreatePackage(*FamilyPackageName);
		FamilyFont = NewObject<UFont>(Package, *FamilyAssetName, RF_Public | RF_Standalone | RF_Transactional);
		if (!FamilyFont)
		{
			Message(nullptr, TEXT("error"), FString::Printf(TEXT("%s: failed to create font family asset '%s'."), *Context, *FamilyPackageName));
			return false;
		}

		FAssetRegistryModule::AssetCreated(FamilyFont);
		Package->MarkPackageDirty();
		++FontsImported;
	}

	FamilyFont->FontCacheType = EFontCacheType::Runtime;

	FCompositeFont& Composite = FamilyFont->GetMutableInternalCompositeFont();
	const FName TypefaceName(*TypefaceNameFor(Ref));

	// Replace an existing entry with the same name, so a reimport updates the face instead of duplicating it.
	Composite.DefaultTypeface.Fonts.RemoveAll([&TypefaceName](const FTypefaceEntry& Entry)
	{
		return Entry.Name == TypefaceName;
	});

	// A .ttc/.otc packs several faces into one file, so bind the face this weight/italic asks for
	// instead of always face 0 (msyh.ttc face 1 is "Microsoft YaHei UI", not a bold face).
	const int32 SubFaceIndex = PickSubFaceIndex(FontFace, Ref.Weight, Ref.bItalic, Ref.SubFace, Family, Context);
	const FFontData FaceData(FontFace, SubFaceIndex);

	FTypefaceEntry Entry;
	Entry.Name = TypefaceName;
	Entry.Font = FaceData;
	Composite.DefaultTypeface.Fonts.Add(Entry);

	// Keep a fallback under NAME_None so a TextBlock that does not name a typeface still renders.
	const bool bHasDefaultEntry = Composite.DefaultTypeface.Fonts.ContainsByPredicate([](const FTypefaceEntry& Existing)
	{
		return Existing.Name == NAME_None;
	});
	if (!bHasDefaultEntry && TypefaceName == FName(TEXT("Regular")))
	{
		FTypefaceEntry DefaultEntry;
		DefaultEntry.Name = NAME_None;
		DefaultEntry.Font = FaceData;
		Composite.DefaultTypeface.Fonts.Insert(DefaultEntry, 0);
	}

	// Glyph fallbacks (CJK): sub-fonts Slate consults per codepoint when the primary face has no
	// glyph for a character. The chain order comes from the layout's fallbacks[] array.
	const int32 FallbacksAdded = RebuildFallbacks(*FamilyFont, Ref, Family, Context);

#if WITH_EDITORONLY_DATA
	Composite.MakeDirty();
#endif

	FamilyFont->MarkPackageDirty();
	FontCache.Add(FamilyKey, FamilyFont);
	TouchedPackages.AddUnique(FamilyFont->GetOutermost());

	// Persist the composite font right here instead of waiting for the importer's final save:
	// a render issued in the same process must see the sub-fonts we just built/removed, not the
	// version that was on disk when the import started (a rebuilt-without-fallbacks layout used to
	// render identically to the previous run because only memory had changed).
	{
		TArray<UPackage*> FontPackages;
		FontPackages.Add(FamilyFont->GetOutermost());
		UEditorLoadingAndSavingUtils::SavePackages(FontPackages, /*bOnlyDirty=*/true);
		Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: font family '%s' rebuilt: %d subfont(s), package %s saved."),
			*Context, *Family, FamilyFont->GetMutableInternalCompositeFont().SubTypefaces.Num(),
			*FamilyFont->GetOutermost()->GetName()));
	}

	// The full identity of what was bound: reused-vs-created family asset, the face, the sub-face
	// inside it, and how many glyph fallbacks ended up in the composite.
	const FString Rebind = FString::Printf(TEXT("[family %s, subface %d, %d fallback sub-font(s)]"),
		bFamilyReused ? TEXT("reused") : TEXT("created"), SubFaceIndex, FallbacksAdded);
	Message(nullptr, TEXT("info"), FallbacksAdded > 0
		? FString::Printf(TEXT("%s: font family '%s' typeface '%s' bound to %s (+%d CJK fallback sub-font(s)) %s"),
			*Context, *Family, *TypefaceName.ToString(), *FontFace->GetPathName(), FallbacksAdded, *Rebind)
		: FString::Printf(TEXT("%s: font family '%s' typeface '%s' bound to %s %s"),
			*Context, *Family, *TypefaceName.ToString(), *FontFace->GetPathName(), *Rebind));
	return true;
}

int32 FHtml2UMGAssetImport::RebuildFallbacks(UFont& FamilyFont, const FH2UAssetRef& Ref, const FString& FamilyName, const FString& Context)
{
	FCompositeFont& Composite = FamilyFont.GetMutableInternalCompositeFont();

	// Drop the sub-fonts a previous import created for THIS family: EditorName carries the family
	// asset name, so other families' sub-fonts survive. A nameless sub-font can only be a leftover
	// of an older build of this importer, so it goes as well.
#if WITH_EDITORONLY_DATA
	const FString SubFontPrefix = FString::Printf(TEXT("H2U_%s_"), *MakeAssetName(FamilyName));
	Composite.SubTypefaces.RemoveAll([&SubFontPrefix](const FCompositeSubFont& SubFont)
	{
		return SubFont.EditorName.IsNone()
			|| SubFont.EditorName.ToString().StartsWith(SubFontPrefix, ESearchCase::IgnoreCase);
	});
#else
	Composite.SubTypefaces.Reset();
#endif

	// Reset the last-resort typeface too, unconditionally: it is rebuilt from the chain below, and a
	// stale one from an earlier import would keep the old CJK face alive after the fallbacks were
	// dropped from the layout.
	Composite.FallbackTypeface.Typeface = FTypeface();
	Composite.FallbackTypeface.ScalingFactor = 1.0f;

	// The chain order is the layout's fallbacks[] array order (the order the browser resolved the
	// text in). It must NOT come from iterating Layout.Fonts: that is a TMap, so its order is the
	// hash order and the first fallback would change run to run.
	TArray<FH2UFontFallback> Fallbacks = Ref.Fallbacks;
	TSet<FString> PrimaryFiles;
	for (const TPair<FString, FH2UAssetRef>& Pair : Layout.Fonts)
	{
		if (!FamilyNameOf(Pair.Value).Equals(FamilyName, ESearchCase::IgnoreCase))
		{
			continue;
		}

		FString PrimaryFile;
		if (ResolveSourceFile(Layout, Pair.Value.File, PrimaryFile))
		{
			PrimaryFiles.Add(PrimaryFile.ToLower());
		}

		// Same family, another weight/italic: it may carry the chain this entry does not have.
		if (!Pair.Key.Equals(Ref.Key, ESearchCase::IgnoreCase))
		{
			Fallbacks.Append(Pair.Value.Fallbacks);
		}
	}

	if (Fallbacks.IsEmpty())
	{
		return 0;
	}

	int32 Added = 0;
	// Block-level bookkeeping for layouts that predate the converter's per-face "coverage": two
	// fallbacks handed the same 16 CJK blocks would overlap completely, and Slate keeps only one
	// typeface per codepoint (ties go to the first declared), so the second would never be asked.
	TSet<int32> ClaimedCjkBlocks;
	TSet<FString> SeenFiles;
	for (const FH2UFontFallback& RawFallback : Fallbacks)
	{
		// The converter lists every fallback as a normal font entry too, so a fallback that only
		// carries its key can still be resolved from that entry.
		FH2UFontFallback Fallback = RawFallback;
		if (Fallback.File.IsEmpty() && !Fallback.Key.IsEmpty())
		{
			if (const FH2UAssetRef* Declared = Layout.Fonts.Find(Fallback.Key))
			{
				Fallback.File = Declared->File;
				if (Fallback.Family.IsEmpty())
				{
					Fallback.Family = Declared->Family;
				}
				if (Fallback.SubFace < 0)
				{
					Fallback.SubFace = Declared->SubFace;
				}
			}
		}

		if (Fallback.File.IsEmpty())
		{
			Message(nullptr, TEXT("warning"), FString::Printf(
				TEXT("%s: fallback '%s' of family '%s' declares neither a file nor a key that resolves to one; skipped."),
				*Context, Fallback.Key.IsEmpty() ? TEXT("<unnamed>") : *Fallback.Key, *FamilyName));
			continue;
		}

		FString AbsFile;
		if (!ResolveSourceFile(Layout, Fallback.File, AbsFile))
		{
			Message(nullptr, TEXT("warning"), FString::Printf(TEXT("%s: fallback font file '%s' for family '%s' was not found; that glyph range keeps the primary face."),
				*Context, *Fallback.File, *FamilyName));
			continue;
		}

		// A fallback that is the family's own file would just shadow the primary face with itself.
		const FString FileKey = AbsFile.ToLower();
		if (PrimaryFiles.Contains(FileKey) || SeenFiles.Contains(FileKey))
		{
			continue;
		}
		SeenFiles.Add(FileKey);

		// ---- which codepoints this face owns ----
		// Preferred: the converter sends a per-face, non-overlapping "coverage" list derived from the
		// font's cmap. Fallback: hand this face the CJK blocks nobody claimed yet, so two fallbacks
		// never receive identical ranges (an overlapping sub-font is never consulted: Slate keeps one
		// typeface per codepoint and gives ties to the first declared).
		TArray<FInt32Range> Ranges;
		if (Fallback.Coverage.Num() > 0)
		{
			Ranges.Reserve(Fallback.Coverage.Num());
			for (const FH2UCharRange& Covered : Fallback.Coverage)
			{
				Ranges.Emplace(Covered.First, Covered.Last + 1); // FInt32Range is half-open
			}
			Ranges.Sort([](const FInt32Range& A, const FInt32Range& B)
			{
				return A.GetLowerBoundValue() < B.GetLowerBoundValue();
			});

			// Merge adjacent/overlapping spans: Slate normalises them anyway, and this keeps the
			// asset's CharacterRanges readable in the font editor.
			TArray<FInt32Range> Merged;
			for (const FInt32Range& Range : Ranges)
			{
				if (Merged.Num() > 0 && Range.GetLowerBoundValue() <= Merged.Last().GetUpperBoundValue() + 1)
				{
					Merged.Last() = FInt32Range(Merged.Last().GetLowerBoundValue(), FMath::Max(Merged.Last().GetUpperBoundValue(), Range.GetUpperBoundValue()));
				}
				else
				{
					Merged.Add(Range);
				}
			}
			Ranges = MoveTemp(Merged);
		}
		else
		{
			const TArray<FInt32Range>& Blocks = GetCjkCharacterRanges();
			for (int32 BlockIndex = 0; BlockIndex < Blocks.Num(); ++BlockIndex)
			{
				if (ClaimedCjkBlocks.Contains(BlockIndex))
				{
					continue;
				}
				ClaimedCjkBlocks.Add(BlockIndex);
				Ranges.Add(Blocks[BlockIndex]);
			}
		}

		if (Ranges.IsEmpty())
		{
			Message(nullptr, TEXT("warning"), FString::Printf(
				TEXT("%s: fallback '%s' of family '%s' covers nothing that the earlier fallbacks do not already serve; not registered (it would never be consulted)."),
				*Context, *Fallback.File, *FamilyName));
			continue;
		}

		UObject* FallbackFace = ImportFallbackFace(Fallback, AbsFile, Context);
		if (!FallbackFace)
		{
			continue;
		}

		// Fallback files can be collections too (msyhbd.ttc), so resolve their face the same way.
		const int32 SubFaceIndex = PickSubFaceIndex(FallbackFace, Fallback.Weight, Fallback.bItalic, Fallback.SubFace, Fallback.File, Context);
		const FFontData FallbackFaceData(FallbackFace, SubFaceIndex);

		FCompositeSubFont SubFont;
		SubFont.ScalingFactor = 1.0f;
		// Cultures stays empty on purpose: a non-empty culture list makes Slate ignore this
		// sub-font for every language that is not listed (see FCachedCompositeFontData::
		// RefreshFontRanges), which is exactly the "Chinese still tofu in a ja/ko project" bug.
		SubFont.CharacterRanges = Ranges;

		// One file, every name text can request. Slate resolves FSlateFontInfo::TypefaceFontName
		// *inside* the typeface it picked for the codepoint, so registering only 'Regular' would
		// make a bold heading fall back to the primary (Latin) face and render tofu again -
		// the usual case, since a CJK fallback is normally shipped as a single Regular file.
		for (const FName& FaceName : GetRequestableTypefaceNames())
		{
			FTypefaceEntry Entry;
			Entry.Name = FaceName;
			Entry.Font = FallbackFaceData;
			SubFont.Typeface.Fonts.Add(Entry);
		}

#if WITH_EDITORONLY_DATA
		SubFont.EditorName = FName(*FString::Printf(TEXT("%s%s"),
			*SubFontPrefix,
			*MakeAssetName(Fallback.Family.IsEmpty() ? FPaths::GetBaseFilename(AbsFile) : Fallback.Family)));
#endif

		Composite.SubTypefaces.Add(SubFont);
		++Added;

		Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: font family '%s' glyph fallback '%s' -> %s (%d codepoint ranges)."),
			*Context, *FamilyName, *Fallback.File, *FallbackFace->GetPathName(), SubFont.CharacterRanges.Num()));
	}

	// Last resort: Slate consults FallbackTypeface when neither the default typeface nor the
	// sub-font has the glyph, and it skips the coverage check there, so it renders rare characters
	// (ext-B names, box drawing) instead of the engine's tofu box. Take the DEEPEST fallback of the
	// chain (the one the browser reached last) and always reassign it: an unconditional reset at the
	// top of this function plus this assignment keeps the typeface in step with the layout.
	if (!Composite.SubTypefaces.IsEmpty())
	{
		const FCompositeSubFont& Last = Composite.SubTypefaces.Last();
		Composite.FallbackTypeface.Typeface = Last.Typeface;
		Composite.FallbackTypeface.ScalingFactor = Last.ScalingFactor;
	}

	return Added;
}

FString FHtml2UMGAssetImport::MakeFaceAssetName(const FString& Prefix, const FString& BaseName, const FString& AbsFile, int32 Weight, bool bItalic) const
{
	FString Stem = FString::Printf(TEXT("%s%s_%d"), *Prefix, *BaseName, Weight);
	if (bItalic)
	{
		Stem += TEXT("_Italic");
	}

	// Content-addressed, like imported textures. Without the hash, "Segoe UI -> a different file"
	// resolved to the already imported UFontFace of the previous file and rendered the old glyphs
	// (md5-identical screenshots after swapping a font file).
	const FMD5Hash Hash = FMD5Hash::HashFile(*AbsFile);
	if (Hash.IsValid())
	{
		Stem += FString::Printf(TEXT("_%s"), *LexToString(Hash).Left(8));
	}
	return MakeAssetName(Stem);
}

UObject* FHtml2UMGAssetImport::ImportFontFace(const FH2UAssetRef& Ref, const FString& AbsFile, const FString& Context)
{
	const FString FaceBaseName = Ref.Family.IsEmpty() ? FPaths::GetBaseFilename(AbsFile) : Ref.Family;
	return ImportFontFaceAs(MakeFaceAssetName(FString(), FaceBaseName, AbsFile, Ref.Weight, Ref.bItalic), AbsFile, Context);
}

UObject* FHtml2UMGAssetImport::ImportFallbackFace(const FH2UFontFallback& Fallback, const FString& AbsFile, const FString& Context)
{
	const FString FaceBaseName = Fallback.Family.IsEmpty() ? FPaths::GetBaseFilename(AbsFile) : Fallback.Family;
	// "FB_" keeps a fallback face from colliding with the primary face of a family that happens to
	// point at the same file, while the content hash still makes repeated imports reuse one asset.
	return ImportFontFaceAs(MakeFaceAssetName(TEXT("FB_"), FaceBaseName, AbsFile, Fallback.Weight, Fallback.bItalic), AbsFile, Context);
}

UObject* FHtml2UMGAssetImport::ImportFontFaceAs(const FString& FaceAssetName, const FString& AbsFile, const FString& Context)
{
	const FString PackageName = FontRoot + TEXT("/") + FaceAssetName;

	if (UObject* Existing = FindExistingAsset(FontRoot, FaceAssetName))
	{
		if (Existing->IsA<UFontFace>() && IsAssetUpToDate(PackageName, AbsFile))
		{
			return Existing;
		}
	}

	UAssetImportTask* Task = NewObject<UAssetImportTask>();
	Task->Filename = AbsFile;
	Task->DestinationPath = FontRoot;
	Task->DestinationName = FaceAssetName;
	Task->bReplaceExisting = true;
	Task->bReplaceExistingSettings = false;
	Task->bAutomated = true;
	Task->bSave = false;

	UFontFileImportFactory* Factory = NewObject<UFontFileImportFactory>();
	// The font family asset is composed below, so do not let the factory create a second UFont.
	Factory->BatchCreateFontAsset = EBatchCreateFontAsset::No;
	Task->Factory = Factory;

	TArray<UAssetImportTask*> Tasks;
	Tasks.Add(Task);

	IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
	AssetTools.ImportAssetTasks(Tasks);

	UObject* FontFace = nullptr;
	for (UObject* Imported : Task->GetObjects())
	{
		if (Imported && Imported->IsA<UFontFace>())
		{
			FontFace = Imported;
			break;
		}
	}

	if (!FontFace)
	{
		Message(nullptr, TEXT("error"), FString::Printf(TEXT("%s: failed to import font face from '%s'."), *Context, *AbsFile));
		return nullptr;
	}

	TouchedPackages.AddUnique(FontFace->GetOutermost());
	return FontFace;
}

int32 FHtml2UMGAssetImport::PickSubFaceIndex(const UObject* FontFace, int32 Weight, bool bItalic, int32 RequestedIndex, const FString& Label, const FString& Context)
{
#if WITH_EDITORONLY_DATA
	const UFontFace* Face = Cast<UFontFace>(FontFace);
	if (!Face)
	{
		return 0;
	}

	// UFontFace::SubFaces holds one "Family (Style)" string per face in the file; a plain .ttf has
	// one entry, so this is a no-op for every single-face font.
	const TArray<FString>& SubFaces = Face->SubFaces;

	// The converter validates the face it picked against the font's cmap, so an index it supplies
	// (including an explicit 0 for a .ttc) beats anything guessed here.
	if (RequestedIndex >= 0)
	{
		if (SubFaces.IsValidIndex(RequestedIndex))
		{
			Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: font '%s' uses layout subface %d of %d (%s)."),
				*Context, *Label, RequestedIndex, SubFaces.Num(),
				SubFaces.Num() > 0 ? *SubFaces[RequestedIndex] : TEXT("unnamed")));
			return RequestedIndex;
		}
		Message(nullptr, TEXT("warning"), FString::Printf(TEXT("%s: font '%s' declares subface %d but the file only has %d face(s); falling back to style matching."),
			*Context, *Label, RequestedIndex, SubFaces.Num()));
	}

	// Nothing to guess for a single-face file, and warning about it would just be noise.
	if (SubFaces.Num() <= 1)
	{
		return 0;
	}

	// The style is the only thing that separates the faces of a collection: msyh.ttc is
	// "Microsoft YaHei (Normal)" + "Microsoft YaHei UI (Normal)" - same family, same weight, the UI
	// variant second. FreeType reports the English style name when the file has one (msyhbd.ttc
	// also stores "Negreta"/"Fett", hence the extra tokens).
	const bool bWantBold = Weight >= 600;
	int32 FallbackIndex = INDEX_NONE;
	for (int32 Index = 0; Index < SubFaces.Num(); ++Index)
	{
		FString Style = SubFaces[Index];
		int32 OpenParen = INDEX_NONE;
		if (Style.FindLastChar(TEXT('('), OpenParen))
		{
			Style = Style.Mid(OpenParen + 1).Replace(TEXT(")"), TEXT(""));
		}

		const bool bFaceBold = StyleHasAnyToken(Style, { TEXT("bold"), TEXT("semibold"), TEXT("negreta"), TEXT("fett"), TEXT("gras"), TEXT("negrita"), TEXT("heavy"), TEXT("black") });
		const bool bFaceItalic = StyleHasAnyToken(Style, { TEXT("italic"), TEXT("oblique"), TEXT("kursiv"), TEXT("corsivo"), TEXT("cursiva") });

		if (bFaceBold == bWantBold && bFaceItalic == bItalic)
		{
			Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: font '%s' weight %d%s picks face %d/%d (%s) by style."),
				*Context, *Label, Weight, bItalic ? TEXT(" italic") : TEXT(""), Index, SubFaces.Num(), *SubFaces[Index]));
			return Index;
		}

		// Partial credit: right weight (or no weight information) is much less wrong than the UI variant.
		if (FallbackIndex == INDEX_NONE && bFaceBold == bWantBold)
		{
			FallbackIndex = Index;
		}
	}

	Message(nullptr, TEXT("warning"), FString::Printf(
		TEXT("%s: font '%s' has %d faces but none matches weight %d%s; using face 0. Faces: [%s]"),
		*Context, *Label, SubFaces.Num(), Weight, bItalic ? TEXT(" italic") : TEXT(""), *FString::Join(SubFaces, TEXT(", "))));

	return FallbackIndex != INDEX_NONE ? FallbackIndex : 0;
#else
	return 0;
#endif
}

UObject* FHtml2UMGAssetImport::Resolve(const FString& Reference, UClass* ExpectedClass, const FString& Context)
{
	if (Reference.IsEmpty())
	{
		return nullptr;
	}

	// "@key" -> the assets declard in the layout
	if (Reference.StartsWith(TEXT("@")))
	{
		const FString Key = Reference.RightChop(1);
		if (Layout.Textures.Contains(Key))
		{
			return EnsureTexture(Key, Context);
		}
		if (Layout.Fonts.Contains(Key))
		{
			return EnsureFont(Key, Context);
		}

		if (!ReportedMissing.Contains(Key))
		{
			ReportedMissing.Add(Key);
			Message(nullptr, TEXT("warning"), FString::Printf(TEXT("%s: asset key '%s' is not declared in this layout."), *Context, *Key));
		}
		return nullptr;
	}

	// "/Game/..." -> an existing asset
	if (Reference.StartsWith(TEXT("/")))
	{
		FString ObjectPath = Reference;
		if (!ObjectPath.Contains(TEXT(".")))
		{
			const FString AssetName = FPackageName::GetShortName(ObjectPath);
			ObjectPath = FString::Printf(TEXT("%s.%s"), *Reference, *AssetName);
		}

		UObject* Asset = LoadObject<UObject>(nullptr, *ObjectPath);
		if (!Asset)
		{
			Message(nullptr, TEXT("warning"), FString::Printf(TEXT("%s: asset '%s' could not be loaded."), *Context, *Reference));
		}
		return Asset;
	}

	// Anything else is a file path: import it as a texture.
	FString AbsFile;
	if (!ResolveSourceFile(Layout, Reference, AbsFile))
	{
		Message(nullptr, TEXT("warning"), FString::Printf(TEXT("%s: asset reference '%s' could not be resolved to a file."), *Context, *Reference));
		return nullptr;
	}

	return ImportTextureFile(Reference, AbsFile, Context);
}
