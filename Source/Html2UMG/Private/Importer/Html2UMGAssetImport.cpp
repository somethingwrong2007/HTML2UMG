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
#include "HAL/FileManager.h"
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
}

FHtml2UMGAssetImport::FHtml2UMGAssetImport(const FH2ULayout& InLayout, const FH2UImportOptions& InOptions)
	: Layout(InLayout)
	, Options(InOptions)
	, OutputRoot(NormalizeRoot(InOptions.AssetOutputRoot))
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
	if (Ref.Weight >= 700)
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

	for (const TPair<FString, FH2UAssetRef>& Pair : Layout.Fonts)
	{
		if (!Options.bImportFonts)
		{
			Message(Sink, TEXT("info"), FString::Printf(TEXT("Font '%s' skipped (font import disabled)."), *Pair.Key));
			continue;
		}
		EnsureFont(Pair.Key, TEXT("asset import"));
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
	// One asset per source file, even when several keys point at it.
	const FString AssetName = MakeAssetName(FPaths::GetBaseFilename(AbsFile));
	const FString PackageName = OutputRoot + TEXT("/") + AssetName;

	if (UObject* Existing = FindExistingAsset(OutputRoot, AssetName))
	{
		UTexture2D* ExistingTexture = Cast<UTexture2D>(Existing);
		if (ExistingTexture && IsAssetUpToDate(PackageName, AbsFile))
		{
			++TexturesReused;
			Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: texture '%s' reused (%s)."), *Context, *Key, *ExistingTexture->GetPathName()));
			return ExistingTexture;
		}
	}

	UAssetImportTask* Task = NewObject<UAssetImportTask>();
	Task->Filename = AbsFile;
	Task->DestinationPath = OutputRoot;
	Task->DestinationName = AssetName;
	Task->bReplaceExisting = true;
	Task->bReplaceExistingSettings = false;
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
		Message(nullptr, TEXT("error"), FString::Printf(TEXT("%s: failed to import texture '%s' from '%s'."), *Context, *Key, *AbsFile));
		return nullptr;
	}

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
	const FString FamilyPackageName = OutputRoot + TEXT("/") + FamilyAssetName;

	UFont* FamilyFont = nullptr;
	if (const TObjectPtr<UFont>* Cached = FontCache.Find(FamilyKey))
	{
		FamilyFont = *Cached;
	}
	else if (UObject* Existing = FindExistingAsset(OutputRoot, FamilyAssetName))
	{
		FamilyFont = Cast<UFont>(Existing);
		if (FamilyFont)
		{
			++FontsReused;
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

	FTypefaceEntry Entry;
	Entry.Name = TypefaceName;
	Entry.Font = FFontData(FontFace);
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
		DefaultEntry.Font = FFontData(FontFace);
		Composite.DefaultTypeface.Fonts.Insert(DefaultEntry, 0);
	}

#if WITH_EDITORONLY_DATA
	Composite.MakeDirty();
#endif

	FamilyFont->MarkPackageDirty();
	FontCache.Add(FamilyKey, FamilyFont);
	TouchedPackages.AddUnique(FamilyFont->GetOutermost());

	Message(nullptr, TEXT("info"), FString::Printf(TEXT("%s: font family '%s' typeface '%s' bound to %s."),
		*Context, *Family, *TypefaceName.ToString(), *FontFace->GetPathName()));
	return true;
}

UObject* FHtml2UMGAssetImport::ImportFontFace(const FH2UAssetRef& Ref, const FString& AbsFile, const FString& Context)
{
	const FString FaceBaseName = Ref.Family.IsEmpty() ? FPaths::GetBaseFilename(AbsFile) : Ref.Family;
	FString FaceAssetName = MakeAssetName(FString::Printf(TEXT("%s_%d"), *FaceBaseName, Ref.Weight));
	if (Ref.bItalic)
	{
		FaceAssetName += TEXT("_Italic");
	}
	const FString PackageName = OutputRoot + TEXT("/") + FaceAssetName;

	if (UObject* Existing = FindExistingAsset(OutputRoot, FaceAssetName))
	{
		if (Existing->IsA<UFontFace>() && IsAssetUpToDate(PackageName, AbsFile))
		{
			return Existing;
		}
	}

	UAssetImportTask* Task = NewObject<UAssetImportTask>();
	Task->Filename = AbsFile;
	Task->DestinationPath = OutputRoot;
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
