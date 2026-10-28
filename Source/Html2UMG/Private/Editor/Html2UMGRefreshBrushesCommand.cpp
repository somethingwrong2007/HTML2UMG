// Copyright (c) 2026 FPVSkyline. MIT License.

#include "CoreMinimal.h"
#include "HAL/IConsoleManager.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "ObjectTools.h"
#include "Modules/ModuleManager.h"
#include "WidgetBlueprint.h"
#include "Blueprint/WidgetBlueprintGeneratedClass.h"
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Widget.h"
#include "Styling/SlateBrush.h"
#include "UObject/Package.h"
#include "FileHelpers.h"
#include "Misc/PackageName.h"
#include "Html2UMGLog.h"

namespace
{
	/** Re-assign brushes' resources so Slate rebuilds the render handle of every one of them. */
	void RefreshBrushFields(const UStruct* Struct, void* Memory, int32 Depth, int32& OutCount)
	{
		if (Struct == nullptr || Memory == nullptr || Depth > 6)
		{
			return;
		}

		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			FStructProperty* StructProperty = CastField<FStructProperty>(*It);
			if (StructProperty == nullptr)
			{
				continue;
			}

			if (StructProperty->Struct == TBaseStructure<FSlateBrush>::Get())
			{
				FSlateBrush* Brush = StructProperty->ContainerPtrToValuePtr<FSlateBrush>(Memory);
				if (Brush != nullptr)
				{
					if (UObject* Resource = Brush->GetResourceObject())
					{
						Brush->SetResourceObject(nullptr);
						Brush->SetResourceObject(Resource);
						OutCount += 1;
					}
				}
			}
			else
			{
				RefreshBrushFields(StructProperty->Struct, StructProperty->ContainerPtrToValuePtr<void>(Memory), Depth + 1, OutCount);
			}
		}
	}

	/**
	 * Html2UMG.RefreshBrushes <widgetBlueprintPath>
	 *
	 * Re-binds every brush in a widget blueprint and saves it.
	 *
	 * A widget style brush (Slider bar, CheckBox images, ...) keeps a render handle, and a handle
	 * created while its texture was not loaded stays empty: the control then paints nothing even
	 * though its properties are correct. Re-assigning the resource invalidates the handle, and this
	 * command does that for a whole blueprint and saves, so the next time it loads it draws.
	 */
	void RefreshBrushesCommand(const TArray<FString>& Args)
	{
		if (Args.Num() == 0)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.RefreshBrushes <widgetBlueprintPath> [<path> ...]"));
			return;
		}

		int32 TotalBlueprints = 0;
		int32 TotalBrushes = 0;
		TArray<UPackage*> PackagesToSave;

		for (const FString& Arg : Args)
		{
			FString Path = Arg.TrimStartAndEnd();
			if (!Path.StartsWith(TEXT("/")))
			{
				Path = TEXT("/Game/") + Path;
			}

			UWidgetBlueprint* Blueprint = LoadObject<UWidgetBlueprint>(nullptr, *Path);
			if (Blueprint == nullptr)
			{
				const FString ShortName = FPackageName::GetShortName(Path);
				Blueprint = LoadObject<UWidgetBlueprint>(nullptr, *FString::Printf(TEXT("%s.%s"), *Path, *ShortName));
			}
			if (Blueprint == nullptr || Blueprint->WidgetTree == nullptr)
			{
				UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG.RefreshBrushes: '%s' is not a loadable Widget Blueprint."), *Path);
				continue;
			}

			int32 Count = 0;
			Blueprint->WidgetTree->ForEachWidget([&Count](UWidget* Widget)
			{
				if (Widget != nullptr)
				{
					RefreshBrushFields(Widget->GetClass(), Widget, 0, Count);
				}
			});

			Blueprint->Modify();
			Blueprint->GetOutermost()->MarkPackageDirty();
			PackagesToSave.Add(Blueprint->GetOutermost());
			TotalBlueprints += 1;
			TotalBrushes += Count;
		}

		if (PackagesToSave.Num() > 0)
		{
			UEditorLoadingAndSavingUtils::SavePackages(PackagesToSave, /*bOnlyDirty=*/true);
		}

		UE_LOG(LogHtml2UMG, Display,
			TEXT("Html2UMG.RefreshBrushes: %d brush(es) re-bound across %d blueprint(s)."),
			TotalBrushes, TotalBlueprints);
	}


	/** Prints the style-brush state of the blueprint tree AND the CDO tree (the runtime template). */
	void InspectBrushesCommand(const TArray<FString>& Args)
	{
		if (Args.Num() == 0)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.InspectBrushes <widgetBlueprintPath>"));
			return;
		}

		FString Path = Args[0].TrimStartAndEnd();
		if (!Path.StartsWith(TEXT("/")))
		{
			Path = TEXT("/Game/") + Path;
		}

		UWidgetBlueprint* Blueprint = LoadObject<UWidgetBlueprint>(nullptr, *Path);
		if (Blueprint == nullptr)
		{
			const FString ShortName = FPackageName::GetShortName(Path);
			Blueprint = LoadObject<UWidgetBlueprint>(nullptr, *FString::Printf(TEXT("%s.%s"), *Path, *ShortName));
		}
		if (Blueprint == nullptr)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG.InspectBrushes: '%s' is not loadable."), *Path);
			return;
		}

		const auto Report = [](const TCHAR* Label, UWidgetTree* Tree)
		{
			if (Tree == nullptr)
			{
				UE_LOG(LogHtml2UMG, Display, TEXT("  [%s] no widget tree"), Label);
				return;
			}
			int32 Widgets = 0;
			Tree->ForEachWidget([&Widgets, Label](UWidget* Widget)
			{
				if (Widget == nullptr)
				{
					return;
				}
				Widgets += 1;
				if (Widget->GetClass()->GetName().Contains(TEXT("Slider")) || Widget->GetClass()->GetName().Contains(TEXT("CheckBox")))
				{
					UE_LOG(LogHtml2UMG, Display, TEXT("  [%s] %s %s class=%s"), Label, *Widget->GetName(),
						*Widget->GetClass()->GetName(), *Widget->GetClass()->GetName());
					int32 Brushes = 0;
					// Dump every brush this widget owns, with its resource and whether it resolves.
					struct FLocal
					{
						static void Walk(const UStruct* Struct, void* Memory, int32 Depth, const TCHAR* Where)
						{
							if (Struct == nullptr || Memory == nullptr || Depth > 5) return;
							for (TFieldIterator<FProperty> It(Struct); It; ++It)
							{
								FStructProperty* SP = CastField<FStructProperty>(*It);
								if (SP == nullptr) continue;
								if (SP->Struct == TBaseStructure<FSlateBrush>::Get())
								{
									FSlateBrush* Brush = SP->ContainerPtrToValuePtr<FSlateBrush>(Memory);
									UObject* Res = Brush ? Brush->GetResourceObject() : nullptr;
									UE_LOG(LogHtml2UMG, Display, TEXT("      [%s] %s.%s -> %s (drawAs=%d imageSize=%.0fx%.0f)"),
										Where, *Struct->GetName(), *SP->GetName(),
										Res ? *Res->GetPathName() : TEXT("<none>"),
										Brush ? static_cast<int32>(Brush->DrawAs) : -1,
										Brush ? Brush->ImageSize.X : 0.0f, Brush ? Brush->ImageSize.Y : 0.0f);
								}
								else
								{
									Walk(SP->Struct, SP->ContainerPtrToValuePtr<void>(Memory), Depth + 1, Where);
								}
							}
						}
					};
					(void)Brushes;
					FLocal::Walk(Widget->GetClass(), Widget, 0, Label);
				}
			});
			UE_LOG(LogHtml2UMG, Display, TEXT("  [%s] %d widget(s)"), Label, Widgets);
		};

		Report(TEXT("design"), Blueprint->WidgetTree);

		// The archetype tree on the generated class is what UUserWidget::Initialize duplicates for
		// every instance - i.e. what actually renders. The design-time tree above is NOT it.
		if (UWidgetBlueprintGeneratedClass* GeneratedClass = Cast<UWidgetBlueprintGeneratedClass>(Blueprint->GeneratedClass))
		{
			Report(TEXT("archetype"), GeneratedClass->GetWidgetTreeArchetype());
			if (UUserWidget* CDO = Cast<UUserWidget>(GeneratedClass->GetDefaultObject()))
			{
				Report(TEXT("cdo"), CDO->WidgetTree);
			}
		}
	}

	struct FInspectBrushesRegistration
	{
		FInspectBrushesRegistration()
		{
			IConsoleManager::Get().RegisterConsoleCommand(
				TEXT("Html2UMG.InspectBrushes"),
				TEXT("Prints style-brush state for the blueprint tree and the CDO tree. Usage: Html2UMG.InspectBrushes <path>"),
				FConsoleCommandWithArgsDelegate::CreateStatic(&InspectBrushesCommand),
				ECVF_Default);
		}
	};

	static FInspectBrushesRegistration GInspectBrushesRegistration;

	struct FRefreshBrushesRegistration
	{
		FRefreshBrushesRegistration()
		{
			IConsoleManager::Get().RegisterConsoleCommand(
				TEXT("Html2UMG.RefreshBrushes"),
				TEXT("Re-binds every brush in a Widget Blueprint and saves it. Usage: Html2UMG.RefreshBrushes <path> [<path> ...]"),
				FConsoleCommandWithArgsDelegate::CreateStatic(&RefreshBrushesCommand),
				ECVF_Default);
		}
	};

	static FRefreshBrushesRegistration GRefreshBrushesRegistration;
}
