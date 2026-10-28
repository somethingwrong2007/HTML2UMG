// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Html2UMG importer: layout.json -> Widget Blueprint.
//
// Pipeline:  validate -> find/create the Widget Blueprint -> import textures/fonts
//            -> rebuild the widget tree -> compile -> save.
// In-place reimport keeps the asset (same object, same path, same graphs, same parent class)
// and reuses every widget whose name+class still match, so BindWidget wiring survives.

#include "Importer/Html2UMGImporter.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Widget.h"
#include "FileHelpers.h"
#include "Html2UMGLog.h"
#include "IAssetTools.h"
#include "Importer/Html2UMGAssetImport.h"
#include "Importer/Html2UMGWidgetBuilder.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Logging/TokenizedMessage.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "WidgetBlueprint.h"
#include "WidgetBlueprintFactory.h"
#include "AssetCompilingManager.h"

static TFunction<void(const FH2UMessage&)> GMessageSink;

namespace
{
	/** Every message goes through here exactly once: result list first, then the external sink. */
	FH2UMessageSink MakeResultSink(FH2UImportResult& OutResult)
	{
		return [&OutResult](const FH2UMessage& Message)
		{
			OutResult.Messages.Add(Message);
			if (GMessageSink)
			{
				GMessageSink(Message);
			}
		};
	}

	/** "/Game/UI/WBP_Foo.WBP_Foo_C" -> "/Game/UI/WBP_Foo"; also normalises slashes. */
	FString NormalizeBlueprintPath(const FString& InPath)
	{
		FString Path = InPath.TrimStartAndEnd();
		Path.ReplaceInline(TEXT("\\"), TEXT("/"));

		int32 DotIndex = INDEX_NONE;
		if (Path.FindChar(TEXT('.'), DotIndex))
		{
			Path.LeftInline(DotIndex);
		}

		if (!Path.StartsWith(TEXT("/")))
		{
			Path = FString(TEXT("/")) + Path;
		}

		while (Path.Len() > 1 && Path.EndsWith(TEXT("/")))
		{
			Path.LeftChopInline(1);
		}

		return Path;
	}

	/** Accepts "/Script/MyGame.MyBaseWidget" and "/Game/UI/BP_Foo.BP_Foo_C". */
	UClass* ResolveParentClass(const FString& InPath, FString& OutError)
	{
		OutError.Reset();
		if (InPath.IsEmpty())
		{
			return nullptr;
		}

		UClass* Loaded = StaticLoadClass(UUserWidget::StaticClass(), nullptr, *InPath);
		if (!Loaded)
		{
			Loaded = FindObject<UClass>(nullptr, *InPath);
		}

		if (!Loaded)
		{
			// A blueprint path may omit the "_C" generated-class suffix.
			const FString WithSuffix = InPath.Contains(TEXT(".")) ? InPath : FString::Printf(TEXT("%s.%s_C"), *InPath, *FPackageName::GetShortName(InPath));
			Loaded = StaticLoadClass(UUserWidget::StaticClass(), nullptr, *WithSuffix);
			if (!Loaded)
			{
				Loaded = LoadObject<UClass>(nullptr, *WithSuffix);
			}
		}

		if (!Loaded)
		{
			OutError = FString::Printf(TEXT("parent class '%s' could not be loaded."), *InPath);
			return nullptr;
		}

		if (!Loaded->IsChildOf(UUserWidget::StaticClass()))
		{
			OutError = FString::Printf(TEXT("parent class '%s' resolves to %s, which does not derive from UUserWidget."),
				*InPath, *Loaded->GetName());
			return nullptr;
		}

		return Loaded;
	}

	UWidgetBlueprint* LoadOrCreateWidgetBlueprint(
		const FString& BlueprintPath,
		UClass* DesiredParentClass,
		const FH2UMessageSink& Sink)
	{
		FAssetRegistryModule& RegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		const FString AssetName = FPaths::GetCleanFilename(BlueprintPath);
		const FString PackagePath = FPaths::GetPath(BlueprintPath);
		const FString ObjectPath = FString::Printf(TEXT("%s.%s"), *BlueprintPath, *AssetName);

		const FAssetData AssetData = RegistryModule.Get().GetAssetByObjectPath(FSoftObjectPath(ObjectPath));
		if (AssetData.IsValid())
		{
			UWidgetBlueprint* Existing = Cast<UWidgetBlueprint>(AssetData.FastGetAsset(true));
			if (!Existing)
			{
				Sink(FH2UMessage(TEXT("error"), FString::Printf(
					TEXT("'%s' already exists but is a %s, not a Widget Blueprint; pick a different asset path."),
					*BlueprintPath, *AssetData.AssetClassPath.GetAssetName().ToString())));
				return nullptr;
			}

			if (DesiredParentClass && Existing->ParentClass != DesiredParentClass)
			{
				Existing->ParentClass = DesiredParentClass;
				FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Existing);
				Sink(FH2UMessage(TEXT("info"), FString::Printf(TEXT("Parent class of '%s' changed to %s."),
					*BlueprintPath, *DesiredParentClass->GetName())));
			}

			Sink(FH2UMessage(TEXT("info"), FString::Printf(TEXT("Reimporting the existing Widget Blueprint '%s'."), *BlueprintPath)));
			return Existing;
		}

		IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
		UWidgetBlueprintFactory* Factory = NewObject<UWidgetBlueprintFactory>();
		Factory->BlueprintType = BPTYPE_Normal;
		Factory->ParentClass = DesiredParentClass ? DesiredParentClass : UUserWidget::StaticClass();

		UObject* Created = AssetTools.CreateAsset(AssetName, PackagePath, UWidgetBlueprint::StaticClass(), Factory, FName(TEXT("Html2UMG")));
		UWidgetBlueprint* CreatedBlueprint = Cast<UWidgetBlueprint>(Created);
		if (!CreatedBlueprint)
		{
			Sink(FH2UMessage(TEXT("error"), FString::Printf(TEXT("Failed to create the Widget Blueprint '%s'."), *BlueprintPath)));
			return nullptr;
		}

		Sink(FH2UMessage(TEXT("info"), FString::Printf(TEXT("Created the Widget Blueprint '%s'."), *BlueprintPath)));
		return CreatedBlueprint;
	}
}

void FHtml2UMGImporter::SetMessageSink(TFunction<void(const FH2UMessage&)> InSink)
{
	GMessageSink = MoveTemp(InSink);
}

int32 FHtml2UMGImporter::LogImportMessages(const FH2UImportResult& Result)
{
	int32 Written = 0;
	for (const FH2UMessage& Message : Result.Messages)
	{
		if (Message.Severity.Equals(TEXT("error"), ESearchCase::IgnoreCase))
		{
			UE_LOG(LogHtml2UMG, Error, TEXT("Html2UMG [error] %s"), *Message.Text);
		}
		else if (Message.Severity.Equals(TEXT("warning"), ESearchCase::IgnoreCase))
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG [warning] %s"), *Message.Text);
		}
		else
		{
			// Info is numerous and noisy; keep it out of the default log.
			UE_LOG(LogHtml2UMG, Verbose, TEXT("Html2UMG [info] %s"), *Message.Text);
			continue;
		}
		++Written;
	}
	return Written;
}

bool FHtml2UMGImporter::ImportLayout(const FH2ULayout& Layout, const FH2UImportOptions& Options, FH2UImportResult& OutResult)
{
	OutResult = FH2UImportResult();
	const FH2UMessageSink Sink = MakeResultSink(OutResult);

	const auto Error = [&Sink](const FString& Text) { Sink(FH2UMessage(TEXT("error"), Text)); };
	const auto Warn = [&Sink](const FString& Text) { Sink(FH2UMessage(TEXT("warning"), Text)); };
	const auto Info = [&Sink](const FString& Text) { Sink(FH2UMessage(TEXT("info"), Text)); };

	if (!Layout.IsValid())
	{
		Error(TEXT("The layout has no root node."));
		return false;
	}

	// ---- 1. target asset ----
	FString RequestedPath = Options.BlueprintPath.IsEmpty() ? Layout.BlueprintPath : Options.BlueprintPath;
	if (RequestedPath.IsEmpty())
	{
		Error(TEXT("No target Blueprint: the layout has no \"blueprint\" field and FH2UImportOptions::BlueprintPath is empty."));
		return false;
	}

	// One page, one folder: /Game/X/WBP_Foo becomes /Game/X/WBP_Foo/WBP_Foo, and the page's
	// textures go into <that folder>/assets (see FHtml2UMGAssetImport::ResolveTextureRoot).
	FString BlueprintPath = NormalizeBlueprintPath(RequestedPath);
	if (Options.bNestPageFolder)
	{
		BlueprintPath = Html2UMG::NestPageFolder(BlueprintPath);
	}
	if (!FPackageName::IsValidLongPackageName(BlueprintPath))
	{
		Error(FString::Printf(TEXT("'%s' is not a valid content path (expected something like /Game/UI/WBP_Design)."), *BlueprintPath));
		return false;
	}

	// ---- 2. optional parent class ----
	FString ParentClassError;
	const FString RequestedParentClass = Options.ParentClassPath.IsEmpty() ? Layout.ParentClassPath : Options.ParentClassPath;
	UClass* ParentClass = ResolveParentClass(RequestedParentClass, ParentClassError);
	if (!ParentClassError.IsEmpty())
	{
		Error(ParentClassError);
		return false;
	}

	// ---- 3. the Widget Blueprint itself ----
	UWidgetBlueprint* WidgetBlueprint = LoadOrCreateWidgetBlueprint(BlueprintPath, ParentClass, Sink);
	if (!WidgetBlueprint || !WidgetBlueprint->WidgetTree)
	{
		if (!OutResult.ErrorCount())
		{
			Error(FString::Printf(TEXT("'%s' has no widget tree."), *BlueprintPath));
		}
		return false;
	}

	OutResult.BlueprintPath = BlueprintPath;

	for (const FString& LayoutWarning : Layout.Warnings)
	{
		Warn(FString::Printf(TEXT("converter: %s"), *LayoutWarning));
	}

	// ---- 4. textures and fonts ----
	FHtml2UMGAssetImport Assets(Layout, Options);
	Assets.ImportAll(Sink);

	// ---- 5. widget tree ----
	UWidgetTree* WidgetTree = WidgetBlueprint->WidgetTree;
	WidgetTree->SetFlags(RF_Transactional);
	WidgetTree->Modify();

	FHtml2UMGWidgetBuilder Builder(*WidgetTree, Assets, Options, Layout.Viewport);
	Builder.SetMessageSink(Sink);

	UWidget* NewRoot = Builder.Build(*Layout.Root, Options.bReimportInPlace);
	if (!NewRoot)
	{
		Error(TEXT("The widget tree could not be built; the target asset was left untouched."));
		return false;
	}

	Info(FString::Printf(TEXT("Widget tree: %d created, %d reused, %d properties set, %d unknown, %d failed."),
		Builder.WidgetsCreated, Builder.WidgetsReused, Builder.PropertiesSet, Builder.UnknownProperties, Builder.FailedProperties));

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBlueprint);

	// ---- 6. compile ----
	if (Options.bCompile)
	{
		FCompilerResultsLog CompilerLog;
		CompilerLog.SetSourcePath(WidgetBlueprint->GetPathName());
		CompilerLog.bLogDetailedResults = true;
		CompilerLog.BeginEvent(TEXT("Compile"));

		FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint, EBlueprintCompileOptions::None, &CompilerLog);

		for (const TSharedRef<FTokenizedMessage>& Message : CompilerLog.Messages)
		{
			const EMessageSeverity::Type Severity = Message->GetSeverity();
			const FString Text = Message->ToText().ToString();

			if (Severity == EMessageSeverity::Error)
			{
				Error(FString::Printf(TEXT("compile: %s"), *Text));
			}
			else if (Severity == EMessageSeverity::Warning || Severity == EMessageSeverity::PerformanceWarning)
			{
				Warn(FString::Printf(TEXT("compile: %s"), *Text));
			}
			else
			{
				Info(FString::Printf(TEXT("compile: %s"), *Text));
			}
		}

		if (CompilerLog.NumErrors > 0)
		{
			Warn(FString::Printf(TEXT("Blueprint compiled with %d error(s) and %d warning(s)."), CompilerLog.NumErrors, CompilerLog.NumWarnings));
		}
		else
		{
			Info(FString::Printf(TEXT("Blueprint compiled (%d warning(s))."), CompilerLog.NumWarnings));
		}
	}

	// ---- 7. save ----
	if (Options.bSave)
	{
		// Let pending asset work finish before writing.
		//
		// Importing a png queues its build; writing the package while that is still in flight stores
		// whatever state the asset happens to be in. Draining the queues first means the file on disk
		// matches what we just built, which is the only state that can be reasoned about later.
		FlushAsyncLoading();
		FAssetCompilingManager::Get().FinishAllCompilation();

		TArray<UPackage*> PackagesToSave;
		PackagesToSave.Add(WidgetBlueprint->GetOutermost());
		for (UPackage* Package : Assets.GetTouchedPackages())
		{
			if (Package)
			{
				PackagesToSave.AddUnique(Package);
			}
		}

		// Save every package we touched, dirty or not. An asset that came back from the importer
		// already marked clean would otherwise be skipped, leaving whatever was on disk before.
		if (!UEditorLoadingAndSavingUtils::SavePackages(PackagesToSave, /*bOnlyDirty=*/false))
		{
			Warn(FString::Printf(TEXT("Saving '%s' (and %d asset package(s)) failed."), *BlueprintPath, Assets.GetTouchedPackages().Num()));
		}
		else
		{
			Info(FString::Printf(TEXT("Saved '%s' plus %d asset package(s)."), *BlueprintPath, Assets.GetTouchedPackages().Num()));
		}
	}

	// ---- 8. report ----
	OutResult.WidgetsCreated = Builder.WidgetsCreated;
	OutResult.WidgetsReused = Builder.WidgetsReused;
	OutResult.PropertiesSet = Builder.PropertiesSet;
	OutResult.bSuccess = OutResult.ErrorCount() == 0;

	UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG: import of '%s' finished (%d created, %d reused, %d properties, %d error(s), %d warning(s))."),
		*BlueprintPath, OutResult.WidgetsCreated, OutResult.WidgetsReused, OutResult.PropertiesSet, OutResult.ErrorCount(), OutResult.WarningCount());

	return OutResult.bSuccess;
}

bool FHtml2UMGImporter::ImportLayoutFile(const FString& JsonFile, const FH2UImportOptions& Options, FH2UImportResult& OutResult)
{
	OutResult = FH2UImportResult();
	const FH2UMessageSink Sink = MakeResultSink(OutResult);

	FH2ULayout Layout;
	TArray<FH2UMessage> ParseMessages;
	if (!FH2ULayout::ParseFromFile(JsonFile, Layout, ParseMessages))
	{
		for (const FH2UMessage& Message : ParseMessages)
		{
			Sink(Message);
		}

		if (OutResult.Messages.Num() == 0)
		{
			Sink(FH2UMessage(TEXT("error"), FString::Printf(TEXT("Could not read the layout '%s'."), *JsonFile)));
		}

		OutResult.bSuccess = false;
		return false;
	}

	// Parse warnings are informational for this call; ImportLayout resets the result.
	for (const FH2UMessage& Message : ParseMessages)
	{
		UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG: %s: %s"), *Message.Severity, *Message.Text);
	}

	return ImportLayout(Layout, Options, OutResult);
}
