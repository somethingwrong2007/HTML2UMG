// Copyright (c) 2026 FPVSkyline. MIT License.

using UnrealBuildTool;

/**
 * Runtime half of the Html2UMG plugin: the widgets an imported layout needs at GAME time.
 * Nothing here may depend on Editor modules - a packaged build has to carry these.
 */
public class Html2UMGRuntime : ModuleRules
{
	public Html2UMGRuntime(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"Engine",
				"UMG",
			}
		);

		PrivateDependencyModuleNames.AddRange(
			new string[]
			{
				"Slate",
				"SlateCore",
			}
		);
	}
}
